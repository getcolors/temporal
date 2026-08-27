import re

from package_temporal_blue import operator


def test_acceptance_script_covers_required_behavior():
    assert re.search(r"healthz", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"409", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"attempts", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"systemctl reboot", operator.ACCEPTANCE_SCRIPT)
    assert re.search(r"systemctl restart docker", operator.ACCEPTANCE_SCRIPT)
