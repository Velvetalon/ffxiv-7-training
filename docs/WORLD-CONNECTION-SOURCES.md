# Offline overworld connection research (read-only evidence)

Date: 2026-09-09.  This report reads the installed-client LGBs through the existing `MapExtract.dll raw` command, plus the already exported `gridania` and `limsa` LGBs.  It does not alter the client, `MapExtract` source, or `world-catalog.json`.

## Result

`ExitRange` is sufficient to obtain a source area's destination `TerritoryType` and to identify the target entrance.  The target entrance is not guessed from map edges: it is an object-ID cross-reference to a `PopRange` in the destination territory's `planmap.lgb`, corroborated by the reverse `ExitRange`.

The two fully verified directed links are:

```json
[
  {
    "from": { "catalogId": "gridania", "territoryId": 132, "lgb": "f1t1/level/planmap.lgb", "exitInstanceId": 1317552, "position": [170.078506, -10.60709, 159.044296] },
    "to": { "catalogId": "f1f1", "territoryId": 148, "name": "Central Shroud", "entrancePopRangeInstanceId": 1317625, "position": [128.939697, 24.95331, -305.200897] },
    "evidence": { "sourceTerritoryType": 148, "sourceDestInstanceId": 1317625, "sourceReturnInstanceId": 1317553, "reverseExitInstanceId": 1317623, "reverseTerritoryType": 132, "reverseDestInstanceId": 1317553, "reverseReturnInstanceId": 1317625 }
  },
  {
    "from": { "catalogId": "limsa", "territoryId": 129, "lgb": "s1t2/level/planmap.lgb", "exitInstanceId": 3876614, "position": [68.030983, 22.497801, -0.034751] },
    "to": { "catalogId": "s1f1", "territoryId": 134, "name": "Middle La Noscea", "entrancePopRangeInstanceId": 2464047, "position": [-26.88685, 38.209862, 146.857605] },
    "evidence": { "sourceTerritoryType": 134, "sourceDestInstanceId": 2464047, "sourceReturnInstanceId": 3876616, "reverseExitInstanceId": 2464045, "reverseTerritoryType": 129, "reverseDestInstanceId": 3876616, "reverseReturnInstanceId": 2464047 }
  }
]
```

There is also a verified continuation, not a fabricated direct Limsa link:

```json
{
  "from": { "catalogId": "s1f1", "territoryId": 134, "name": "Middle La Noscea", "exitInstanceId": 2464048 },
  "to": { "catalogId": "s1f2", "territoryId": 135, "name": "Lower La Noscea", "entrancePopRangeInstanceId": 2453664, "position": [240.425995, 74.443367, -332.72641] },
  "evidence": { "sourceDestInstanceId": 2453664, "sourceReturnInstanceId": 2464050, "reverseExitInstanceId": 2453662, "reverseDestInstanceId": 2464050, "reverseReturnInstanceId": 2453664 }
}
```

## Actual LGB layout and offsets

Meddle's generic instance header is 48 bytes (`0x30`): `type:u32`, `instanceId:u32`, `nameOffset:u32`, followed by translation/rotation/scale vectors.  Lumina's `ExitRangeInstanceObject.Read` begins immediately at `object + 0x30`.

| Relative offset | Type | Field |
| ---: | --- | --- |
| `0x00` | `u32` | `LayerEntryType` (`0x29` = `ExitRange`, `0x28` = `PopRange`) |
| `0x04` | `u32` | `InstanceId` |
| `0x0c` | `float[3]` | source trigger transform translation |
| `0x30` | `i32` | `TriggerBoxShape` |
| `0x34` | `i16` | trigger priority |
| `0x36` | `u8` | trigger enabled |
| `0x3c` | `i32` | `ExitType` |
| `0x40` | `u16` | `ZoneId` |
| `0x42` | `u16` | **destination `TerritoryType`** |
| `0x44` | `i32` | `Index` (all three verified outdoor/city links are `-1`) |
| `0x48` | `u32` | **`DestInstanceId`** — target territory's `PopRange` entrance instance |
| `0x4c` | `u32` | **`ReturnInstanceId`** — reciprocal source-side entrance token |
| `0x50` | `float` | `PlayerRunningDirection` |

For `PopRange`, data begins at `object + 0x30`: `PopType:i32 @ +0x30`, relative-positions address/count at `+0x34/+0x38`, `InnerRadiusRatio:f32 @ +0x3c`, and `Index:u8 @ +0x40`.  Its instance transform is the usable offline spawn/entrance coordinate.  The optional relative polygon is not needed for a point-to-point transition, but can later define the arrival footprint.

### Byte-level source proof

New Gridania source object is at decimal `22596` (`0x5844`) in `<exports>/gridania/bg/ffxiv/fst_f1/twn/f1t1/level/planmap.lgb`.  Its subtype bytes from `+0x30` are:

```
01 00 00 00 64 00 01 00 00 00 00 00 01 00 00 00
00 00 94 00 ff ff ff ff f9 1a 14 00 b1 1a 14 00 d8 18 be 3f
```

Decoded: shape `1`, priority `100`, enabled `1`, exitType `1`, ZoneId `0`, TerritoryType `0x0094 = 148`, Index `-1`, DestInstanceId `0x00141af9 = 1317625`, ReturnInstanceId `0x00141ab1 = 1317553`, direction `1.48513317`.

Limsa Lower Decks source object is at decimal `10212` (`0x27e4`) in `<exports>/limsa/bg/ffxiv/sea_s1/twn/s1t2/level/planmap.lgb`.  Its subtype bytes from `+0x30` are:

```
01 00 00 00 64 00 01 00 00 00 00 00 01 00 00 00
00 00 86 00 ff ff ff ff 2f 99 25 00 08 27 3b 00 db 0f c9 3f
```

Decoded: TerritoryType `0x0086 = 134`, DestInstanceId `0x0025992f = 2464047`, ReturnInstanceId `0x003b2708 = 3876616`.

## Why the matching is conclusive

The `DestInstanceId` is found as a `PopRange` in the declared destination territory.  A reverse `ExitRange` then swaps the pair: its `TerritoryType` is the original source territory, its `DestInstanceId` equals the original `ReturnInstanceId`, and its `ReturnInstanceId` equals the original `DestInstanceId`.  Both Gridania/Central Shroud and Limsa/Middle La Noscea satisfy all three conditions.  This is an object-identity match, independent of game knowledge or estimated boundary coordinates.

The lower-deck source `s1t2/planmap.lgb` has four nonzero destination exits: three to territory `128` (Limsa Upper Decks) and one to `134` (Middle La Noscea).  It has no `TerritoryType=135` ExitRange.  Therefore do **not** generate `limsa (129) -> Lower La Noscea (135)` from this source; Lower La Noscea is reached by the separately verified `Middle (134) -> Lower (135)` edge.

## Implementation contract

For each catalog scene, raw-read only `level/planmap.lgb` first.  For every enabled `ExitRange` where `TerritoryType` exists in `world-catalog.json` and `DestInstanceId != 0`:

1. Create an edge with `fromTerritory`, `toTerritory = TerritoryType`, source trigger transform, `exitInstanceId`, `index`, direction, and both instance IDs.
2. Raw-read the target territory's `level/planmap.lgb`; locate `PopRange.InstanceId == DestInstanceId`.  Use its transform as `targetEntrance`.
3. Independently validate the reciprocal ExitRange using the swapped `(DestInstanceId, ReturnInstanceId)` pair.  If absent, retain the edge but mark it `unpaired` instead of inventing an entrance.
4. Omit `DestInstanceId == 0` records from navigable edges; they occur in the supplied data and cannot identify an entrance.

`TerritoryType` is already the destination territory row ID and joins directly to catalog `scene.territoryId`; an additional EXD table is **not** required for these standard city/overworld transitions.  EXD becomes necessary only for non-ExitRange scripted teleports/doors whose destination is referenced by an event or quest ID rather than this direct object pair.

## Reproducible parser

`work/parse_lgb_connections.py` is standalone, read-only against LGB input.  It implements the offsets above and emits JSON.  Example:

```powershell
python work/parse_lgb_connections.py <exports>/gridania/bg/ffxiv/fst_f1/twn/f1t1/level/planmap.lgb --all
```

Meddle source consulted: `Meddle.Formats/Files/LgbFile.cs` (group/object addressing and enum values).  Lumina source consulted: `Lumina/Data/Parsing/Layer/LayerCommon.cs` (`ExitRangeInstanceObject`, `PopRangeInstanceObject`, and `TriggerBoxInstanceObject`).
