# Validation fixtures and time calibration

This directory is the P6 real-world validation contract. It keeps G-code, the
matching machine log, provenance, hashes, parser expectations, and calibration
role together so a fixture cannot silently drift away from its claim.

The bundled fixtures are deliberately labelled `synthetic-conformance`. They
use Cura, PrusaSlicer, OrcaSlicer, SuperSlicer, Marlin, Klipper, and
RepRapFirmware syntax, but they are compact hand-authored files—not production
captures. Their generated calibration report proves the pipeline is
reproducible; it does **not** prove production timing accuracy.

Run:

```bash
npm run validate:fixtures
npm run calibrate:time
```

`validate:fixtures` verifies both SHA-256 hashes, parses every pair, checks the
expected layers/material/path types, fits on `training`, evaluates `holdout`,
and rejects a stale report. `calibrate:time` regenerates the deterministic
report after an intentional fixture update.

## Contributing a real fixture

1. Remove model/customer/file-system identifiers and secrets from both files.
2. Use `real-anonymized` only when you can document collection and
   anonymization responsibility; use `real-consented` when redistribution was
   explicitly approved.
3. Keep one G-code file paired with the log from that exact job. Put the G-code
   SHA-256 in `job.gcodeSha256`.
4. Record the slicer, firmware, machine profile, bed origin, license, and source
   note in `fixture-manifest.json`.
5. Assign new observations to `holdout` first. Promote them into training only
   after review; do not tune the model against its own holdout.
6. Run `npm run calibrate:time`, inspect the error metrics, then run
   `npm run release:check`.

Never commit raw customer G-code or logs when redistribution rights or
de-identification are uncertain.
