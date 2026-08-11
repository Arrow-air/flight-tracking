# v1 → v2 import — skip report

Generated 2026-08-11T02:47:09.359Z. Everything the devkit-only filter (and
dedupe/consistency rules) excluded, with reasons. See ../mapping.md.

## Skipped aircraft
- **Spearhead Testbed - Stork VTOL** (serial `SPH-STRK-TR01A`, type "Stork VTOL", owner alperenag)
  - reason: aircraft_type "Stork VTOL" is not Quiver-devkit data (filter: /^Quiver/)
  - dropped with it: 2 legs, 2 leg logs, 0 notes, 1 maintenance entries
- **Jis M40** (serial `NA`, type "QuadCopter", owner As Balcerak)
  - reason: JIS M-40 ("Jis M40", serial "NA") — explicitly excluded by Thomas (2026-08-09): not devkit-attributable; the mystery record dies with v1.
  - dropped with it: 0 legs, 0 leg logs, 0 notes, 1 maintenance entries

## Skipped flight-log rows (duplicate checksum)
- v1 log `038c6a26-6047-4283-a1b8-e7d054b24113` (00000091.bin): duplicate checksum — same physical file already imported as v1 log 19da6772-cee7-48f2-b402-c4afb6a68bb9 (leg a72173f3-6ccf-464b-bed6-edc5cd03c436); v2 flight_logs.checksum is UNIQUE
- v1 log `f9700d14-7d0b-4d7e-9562-3ceb45de559d` (00000042.bin): duplicate checksum — same physical file already imported as v1 log dbfd3384-c811-41ac-a362-df7f68be9176 (leg eb38b572-0392-48e8-a69c-995d2505b27c); v2 flight_logs.checksum is UNIQUE
- v1 log `8ed03375-65f1-4c66-9afc-7ec6f3528ce7` (8d3a1323-5512-46f6-b61e-aaaa96ac42cc_00000024.bin): duplicate checksum — same physical file already imported as v1 log e87058aa-7c31-4af0-a790-7c7ba798cd9b (leg 27805b72-6140-41c4-bcb7-fbba636cc485); v2 flight_logs.checksum is UNIQUE

## Storage objects not staged
- `2c32bf07-4827-4f5e-a221-ad0a119a8857/a72173f3-6ccf-464b-bed6-edc5cd03c436/2025/08/16/eb086afc-e4ff-4e32-8f47-9ed702733907_00000091.bin`: not referenced by any v1 flight_leg_logs row
- `a72173f3-6ccf-464b-bed6-edc5cd03c436/00000079.BIN`: not referenced by any v1 flight_leg_logs row
- `bd1b6a72-23eb-4c8a-80aa-239f2c072ca1/c873f639-4671-4515-8ac9-949ed833f89b_00000091.bin`: referenced by a skipped/duplicate flight_leg_logs row
- `9a8fa90d-0320-44e0-98bb-1882e695fef7/b7a26556-02f2-4411-8484-60f075dc0bf5_00000014.bin`: referenced by a skipped/duplicate flight_leg_logs row
- `f3fdd4ed-b5ec-49d6-b1a2-7c5e56c1ba48/1abeb80c-971d-4c91-937a-a44e92893b76_00000015.bin`: referenced by a skipped/duplicate flight_leg_logs row
- `c52c5acd-0879-4629-8811-2af87dc3c3cc/5e67cf35-28e7-4d00-87aa-ff7e150af43c_00000042.bin`: referenced by a skipped/duplicate flight_leg_logs row
- `e03ee93f-5ec6-49e8-8a05-3767f71d326d/e2856310-5102-440b-b084-83d71938141d_8d3a1323-5512-46f6-b61e-aaaa96ac42cc_00000024.bin`: referenced by a skipped/duplicate flight_leg_logs row

## v1 users not imported
- Dow Fisher KBM <kbm@arrowair.com>: not referenced by any kept (Quiver-devkit) data
- adam <adam@gmail.co>: not referenced by any kept (Quiver-devkit) data
- Alex Dada <alexdada555@arrowair.com>: not referenced by any kept (Quiver-devkit) data
- nuaim <test.nuaimmf@gmail.com>: not referenced by any kept (Quiver-devkit) data
- Bryan Blake <bryanblakedesign@gmail.com>: not referenced by any kept (Quiver-devkit) data
- alperenag <aalperen.gundogan@arrowair.com>: not referenced by any kept (Quiver-devkit) data
- Vitalii <bondarenko.vs@gmail.com>: not referenced by any kept (Quiver-devkit) data
- Amin Fadel <aminfadel2004@gmail.com>: not referenced by any kept (Quiver-devkit) data
- khalil <khalilzaryani007@gmail.com>: not referenced by any kept (Quiver-devkit) data
- As Balcerak <asbalcerak22@gmail.com>: not referenced by any kept (Quiver-devkit) data
