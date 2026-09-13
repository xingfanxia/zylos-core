# CL subscription rotation before Azure

The three CL agents use runtime skill overlays maintained on
`deploy/upstream-v071-20260820`, even though their installed core package is
0.8.1. The deployed runtime-failover and quota-recovery files match that branch
at 8290933. This change updates only those runtime overlays.

The root account rotator selects another subscription at 95%. Its minute-based
check can lag the ten-second Azure fallback controller. As already implemented
for PPM, a fresh available rotation marker gives the rotator at most 120 seconds
from the first threshold observation. The deadline survives restarts, new
markers and missing quota/marker reads. Fresh usage below threshold clears it;
stale/unavailable rotation state never authorizes a wait. Native health failures
retain their existing fallback rules, and expiry allows Azure to take over.

Existing model, reasoning, account-bound recovery holds, five-minute dwell,
Slack routing and session behavior are retained. No core package downgrade or
PPM multi-session stack is part of this deployment.

Validation: 39 focused failover, rotation and quota-recovery tests passed on
Mac and the CL host's existing Node 24.14.1. Live acceptance uses each role's
actual isolated HOME/ZYLOS_DIR and profile document. Synthetic high usage is
only evaluated in memory; no production quota file or active session is changed.
