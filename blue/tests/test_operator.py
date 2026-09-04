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
