import re

from package_temporal_blue import operator


def test_acceptance_script_covers_required_behavior():
    assert re.search(r"healthz", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"409", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"attempts", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"systemctl reboot", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"systemctl restart docker", operator.ACCEPTANCE_SCRIPT)
    # Keygen mode: the deployment's own key is the machine's only access key.
    assert re.search(r"IdentitiesOnly=yes -i", operator.ACCEPTANCE_SCRIPT)

async def test_acceptance_uses_owned_state_before_running(tmp_path):
    from conftest import ROOT
    from types import SimpleNamespace
    calls=[]
    async def load(opts,env):
        calls.append('state')
        return {**opts,'blue/exit':0,'ip':'203.0.113.7','user':'ubuntu','ssh-private-key-path':'/tmp/operator-key'}
    def run(argv):
        calls.append(argv)
        return SimpleNamespace(exit=0,out='',err='')
    result=await operator.run(str(ROOT/'test/fixtures/colors.yml'),[],run,{},load)
    assert result['blue/exit']==0 and calls[0]=='state'
    assert calls[1][-3:]==['/tmp/operator-key','203.0.113.7','ubuntu']
    assert 'getent' not in operator.ACCEPTANCE_SCRIPT
    assert 'sudo -n -- sh -c' in operator.ACCEPTANCE_SCRIPT

async def test_acceptance_refuses_unreadable_or_destroyed_state():
    from conftest import ROOT
    for response in [{'blue/exit':1,'blue/err':'state unreadable'},{'blue/exit':0,'temporal/already-destroyed':True}]:
        async def load(opts,env):return response
        def forbidden(*args):raise AssertionError('acceptance must not execute')
        result=await operator.run(str(ROOT/'test/fixtures/colors.yml'),[],forbidden,{},load)
        assert result['blue/exit']==1
