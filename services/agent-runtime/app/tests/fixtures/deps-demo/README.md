# deps-demo fixture repository

A deterministic fixture for Dev Room's Phase 1a sandbox setup phase.
`requirements.txt` declares a third-party dependency (`six`), so preparing
this repository exercises the network-enabled setup phase and its snapshot
into the network-isolated agent phase — unlike `agentguard-demo`, which has
no dependencies and never triggers a setup phase at all.
