# ForgeX Stage 6-B through 6-D evidence

- Baseline: `c3fc829e2afe5684ec17c53c89e3dce316f9a1a9` (Stage 6-A), OpenAPI without 429 admission and JobGate 31/31.
- Modified: atomic owner/tenant admission, bounded previous-secret rotation, capacity/security/SLO/alert/recovery/release-rollback closure; JobGate 37/37.
- Runtime capacity fixture: 16 concurrent requests, 98,153 bytes each; final observed p95 is recorded verbatim in `verification/dotnet-production-gates.log`.
- Recovery: backup, hash verification, corruption rejection, empty-target restore, RPO 0 and RTO under five minutes.
- Browser: 35 default cross-browser tests plus 1 async G-code and 2 real Analytics authority tests pass.
- `artifact-manifest.txt` records SHA-256 and byte length for every required role.
