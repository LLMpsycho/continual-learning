"""Standard-library CLI regression checks; synthetic local data only."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'hooks/continual_learning_stop.js'
ENV = {k: v for k, v in os.environ.items() if not k.startswith('CONTINUAL_LEARNING_')}
RESULTS = []

def execute(args, payload='', extra=None):
    return subprocess.run(args, input=payload, text=True, capture_output=True,
                          env={**ENV, **(extra or {})}, timeout=30)

def cli(*args):
    return execute(['node', str(SCRIPT), *map(str, args)])

def read(file):
    return json.loads(file.read_text())

def write(file, value):
    file.write_text(json.dumps(value))

def fixture(root, name):
    directory = root / name
    directory.mkdir(parents=True)
    transcript = directory / 'session.jsonl'
    transcript.write_text('{"type":"user","message":{"role":"user","content":"Synthetic correction."}}\n')
    return directory, transcript, directory / 'continual-learning.json'

def seed(f, **extra):
    write(f[2], {'version': 1, 'lastRunAtMs': 0, 'turnsSinceLastRun': 10,
                'lastTranscriptMtimeMs': None, 'trialStartedAtMs': None, **extra})

def hook(f, event, extra=None, env=None):
    payload = {'hook_event_name': event, 'cwd': str(f[0]), 'transcript_path': str(f[1])}
    if event == 'UserPromptSubmit':
        payload['prompt'] = 'Synthetic prompt.'
    payload.update(extra or {})
    result = execute(['node', str(SCRIPT)], json.dumps(payload), env)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

def check(name, action):
    try:
        action()
        RESULTS.append({'name': name, 'passed': True})
    except Exception as error:
        RESULTS.append({'name': name, 'passed': False, 'error': str(error)})

with tempfile.TemporaryDirectory(prefix='continual-learning-check-') as temporary:
    root = Path(temporary)

    def arguments():
        assert '--complete' in cli('--help').stdout
        assert cli('--unknown').returncode != 0
        assert execute(['bash', str(ROOT / 'install.sh'), '--help']).returncode == 0
        assert execute(['bash', str(ROOT / 'install.sh'), 'invalid']).returncode != 0
    check('CLI help and invalid arguments', arguments)

    def first_run():
        f = fixture(root, 'first'); seed(f)
        assert hook(f, 'Stop').get('decision') == 'block'
        state = read(f[2])
        assert state['lastRunAtMs'] == 0, 'scheduling consumed cooldown before success'
        assert state['turnsSinceLastRun'] == 10
        assert state['pending']['id']
        assert hook(f, 'Stop') == {}
        assert hook(f, 'Stop', {'stop_hook_active': True}) == {}
    check('first run schedules once without consuming cooldown', first_run)

    def completion():
        f = fixture(root, 'completion'); seed(f); hook(f, 'Stop')
        identifier = read(f[2])['pending']['id']
        assert cli('--complete', f[2], identifier).returncode != 0
        assert read(f[2])['lastRunAtMs'] == 0
        hook(f, 'UserPromptSubmit')
        assert cli('--renew', f[2], identifier).returncode == 0
        write(f[0] / 'continual-learning-index.json', {
            'version': 2, 'completedRequestId': identifier, 'transcripts': {}})
        assert cli('--complete', f[2], identifier).returncode == 0
        state = read(f[2])
        assert state['turnsSinceLastRun'] == 1
        assert state['lastRunAtMs'] > 0 and state['pending'] is None
        assert cli('--complete', f[2], identifier).returncode == 0
        assert hook(f, 'Stop') == {}
    check('completion requires index acknowledgement and retains new prompts', completion)

    def retry():
        f = fixture(root, 'retry'); seed(f); hook(f, 'Stop')
        state = read(f[2]); identifier = state['pending']['id']
        state['pending']['expiresAtMs'] = 1; write(f[2], state)
        assert hook(f, 'Stop').get('decision') == 'block'
        assert read(f[2])['pending']['id'] != identifier
        assert cli('--complete', f[2], identifier).returncode != 0
        assert cli('--renew', f[2], identifier).returncode != 0
        assert read(f[2])['turnsSinceLastRun'] == 10
    check('abandoned update retries and stale tokens are rejected', retry)

    def gates():
        f = fixture(root, 'cooldown')
        seed(f, lastRunAtMs=int(time.time() * 1000) - 60 * 60000)
        assert hook(f, 'Stop') == {}
        seed(f, lastRunAtMs=int(time.time() * 1000) - 121 * 60000)
        assert hook(f, 'Stop').get('decision') == 'block'
        f = fixture(root, 'trial'); seed(f, turnsSinceLastRun=2)
        hook(f, 'UserPromptSubmit', env={'CONTINUAL_LEARNING_TRIAL_MODE': '1'})
        assert hook(f, 'Stop', env={'CONTINUAL_LEARNING_TRIAL_MODE': '1'}).get('decision') == 'block'
    check('cooldown and trial gates preserved', gates)

    def events():
        f = fixture(root, 'events'); seed(f, turnsSinceLastRun=0)
        hook(f, 'UserPromptSubmit', {'prompt': '<task-notification>synthetic</task-notification>'})
        hook(f, 'Stop'); hook(f, 'SessionStart')
        assert read(f[2])['turnsSinceLastRun'] == 0
        hook(f, 'UserPromptSubmit')
        assert read(f[2])['turnsSinceLastRun'] == 1
    check('synthetic prompts and unrelated events do not count', events)

    def corrupt():
        f = fixture(root, 'corrupt'); f[2].write_text('{invalid')
        result = execute(['node', str(SCRIPT)], json.dumps({
            'hook_event_name': 'Stop', 'cwd': str(f[0]), 'transcript_path': str(f[1])}))
        assert result.returncode != 0
        assert f[2].read_text() == '{invalid'
        assert result.stderr and '{invalid' not in result.stderr
    check('corrupt state is reported and preserved', corrupt)

    def isolation():
        a, b = fixture(root, 'claude-a'), fixture(root, 'claude-b')
        hook(a, 'UserPromptSubmit'); hook(b, 'UserPromptSubmit')
        assert read(a[2])['turnsSinceLastRun'] == read(b[2])['turnsSinceLastRun'] == 1
        f = fixture(root, 'codex/sessions/2026/10/06')
        for name in ('sample-a', 'sample_a'):
            cwd = root / name; cwd.mkdir()
            hook(f, 'UserPromptSubmit', {'cwd': str(cwd)})
        states = list((root / 'codex/continual-learning').glob('*/continual-learning.json'))
        assert len(states) == 2, 'distinct Codex project paths share state'
        assert all(read(p)['turnsSinceLastRun'] == 1 for p in states)
    check('Claude and Codex project state isolation', isolation)

    def concurrency():
        f = fixture(root, 'concurrency'); seed(f, turnsSinceLastRun=0)
        with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
            list(pool.map(lambda _: hook(f, 'UserPromptSubmit'), range(48)))
        assert read(f[2])['turnsSinceLastRun'] == 48, 'concurrent increments were lost'
        with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
            outputs = list(pool.map(lambda _: hook(f, 'Stop'), range(24)))
        assert sum(o.get('decision') == 'block' for o in outputs) == 1
        assert read(f[2])['turnsSinceLastRun'] == 48
    check('48 concurrent prompts and 24 concurrent Stops', concurrency)

    def installation():
        directory = root / "profile with 'quote'"; directory.mkdir()
        settings = directory / 'settings.json'
        write(settings, {'theme': 'dark', 'env': {'CONTINUAL_LEARNING_MIN_TURNS': '7'},
                         'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'echo retained'}]}]}})
        for _ in range(2):
            result = execute(['bash', str(ROOT / 'install.sh'), 'claude'], extra={'CLAUDE_CONFIG_DIR': str(directory)})
            assert result.returncode == 0, result.stderr
        config = read(settings)
        assert config['theme'] == 'dark' and config['env']['CONTINUAL_LEARNING_MIN_TURNS'] == '7'
        assert config['pluginConfigs']['cc-plugin-agents-md@builtin']['options']['instructionFiles'] == 'claude-md-and-agents-md'
        assert len(config['hooks']['Stop']) == 2 and len(config['hooks']['UserPromptSubmit']) == 1
        f = fixture(root, 'installed')
        command = config['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']
        result = execute(['bash', '-c', command], json.dumps({'hook_event_name': 'UserPromptSubmit',
            'cwd': str(f[0]), 'transcript_path': str(f[1]), 'prompt': 'Synthetic prompt.'}))
        assert result.returncode == 0, result.stderr
        assert read(f[2])['turnsSinceLastRun'] == 1
    check('installer preserves settings, handles quoted paths, and is idempotent', installation)

report = {'command': 'python3 tests/cli_self_check.py', 'node': execute(['node', '--version']).stdout.strip(),
          'prerequisites': 'Node.js 18+, Python 3, bash; synthetic temporary data only; no model or credentials',
          'results': RESULTS, 'passed': all(item['passed'] for item in RESULTS)}
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['passed'] else 1)
