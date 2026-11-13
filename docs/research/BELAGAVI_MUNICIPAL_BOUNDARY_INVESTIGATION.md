# Belagavi municipal boundary investigation

**Status (13 Nov 2026): classification B: official KGIS boundary, but current jurisdiction and date uncertain.**
The official KGIS town and ward layers for Belagavi were downloaded and validated. They are geometrically clean and agree exactly with each other. They are **not** a legally notified, dated corporation boundary, and the town polygon **includes the Belagavi Cantonment area** as a 59th unit. The app is unchanged: the eight demand zones, captain positions and the map are untouched, and no boundary is drawn.

## 1. Provenance and download details
Both files came **directly from the official KGIS portal** (Karnataka State Remote Sensing Applications Centre, KSRSAC). The GitHub mirror (samashti/KGIS) was **not** used for the data.

How the URLs were found:
- The portal's downloads page (https://kgis.ksrsac.in/kgis/downloads.aspx) fills its town dropdown from `portal.asmx/BindDistrict_Urban`, which lists 315 towns.
- "BELAGAVI" has AOI code `0105`. "BELAGALI" (`0204`) is a different town and was excluded.
- The page script `GIS_JS/VillageMap.js` builds the links as `.../Town/Shapefiles/{code}_{name}.zip` and `.../Ward/Shapefiles/{code}_{name}.zip`.
- The `towns/Belagavi.rar` and `wards/Belagavi.rar` names in the mirror's README are older paths. The official equivalents of those two files now return 404 at `/PDF_KML_SHP/Town|Ward/Shapefile/Belagavi.rar`.

| | Town boundary | Ward boundary |
|---|---|---|
| Source URL | https://kgis.ksrsac.in/kgisdocuments/PDF_KML_SHP/Town/Shapefiles/0105_BELAGAVI.zip | https://kgis.ksrsac.in/kgisdocuments/PDF_KML_SHP/Ward/Shapefiles/0105_BELAGAVI.zip |
| Retrieved (UTC) | 2026-11-13 17:37:39 | 2026-11-13 17:37:40 |
| HTTP | 200, `application/x-zip-compressed` | 200, `application/x-zip-compressed` |
| Server Last-Modified | Mon, 12 Oct 2026 09:53:56 GMT | Mon, 12 Oct 2026 13:02:46 GMT |
| Size | 5,956 bytes | 51,401 bytes |
| SHA-256 | `2be920c3aa6530693b3258f208600cb437abc5457c1458b3657039642e38bad9` | `9b26877397e02a7f5f4683c869b1d0f718c44923011745e5d552dbd9ae2a1ade` |
| Contents (listed before extraction) | `0105_BELAGAVI.shp/.shx/.dbf/.prj/.cpg/.sbn/.sbx`, timestamped 12 Oct 2026 15:23 | the same 7 parts, 12 Oct 2026 18:32 |

Archive safety: plain file names only (no directories, no absolute paths, no `..`), and no executables. The archives were extracted only into a temporary research directory outside the repository, and nothing in them was executed. The raw files are **not** in Git.

Tools: Windows `tar.exe` (libarchive 3.8.9) for listing and extracting. The analysis used standard-library Python only (my own shapefile and dBase readers, shoelace areas, segment-intersection checks and a scanline raster), because no GIS packages are installed and none were added.

## 2. Dataset metadata
| | Town | Ward |
|---|---|---|
| Format | ESRI Shapefile, Polygon (type 5), UTF-8 attributes | same |
| CRS | WGS 84 / UTM zone 43N (EPSG:32643), metres | same |
| Features | 1 | 59 |
| Vertices | 368 | 6,276 |
| Fields | `KGISTownID`, `KGISTownCo`, `LGD_TownCo`, `KGISTownNa`, `Town_Type`, `KGISDistri`, `SHAPE_STAr`, `SHAPE_STLe` | `KGISWardID`, `KGISWardCo`, `LGD_WardCo`, `KGISWardNo`, `KGISWardNa`, `KGISTownCo`, `SHAPE_STAr`, `SHAPE_STLe` |
| Key values | `KGISTownNa` = BELAGAVI, `KGISTownCo` = 0105, **`Town_Type` = CC** (City Corporation), **`LGD_TownCo` = 251824**, `KGISDistri` = 01 | 58 numbered wards (`KGISWardNo` 1–58) plus one feature `KGISWardNo` = `KGISWardNa` = "Cantonment" (`LGD_WardCo` = 0) |
| Bounding box (WGS 84) | 15.80108–15.93176 N, 74.47517–74.57893 E | identical |
| Area | 92.1026 km² | 92.1026 km² (sum) |
| Publication or revision date | **not stated** in the data; there is no metadata file. Only file timestamps (12 Oct 2026) and the server's Last-Modified | same |
| Administrative authority statement | **none** in the data | none |

UTM areas at this location, about 0.5° from the central meridian, are understated by under 0.1% compared with true ellipsoidal area. Stored `SHAPE_STAr` values match the computed areas within 50 m² per feature.

## 3. Geometric validation
- **Town:** 1 polygon, one ring, closed, no self-intersections, no holes, valid.
- **Wards:** all 59 features have closed rings with at least 4 points and **no self-intersections** (exhaustive segment-pair test per ring) and no holes.
  - One multipart feature: **Cantonment**, in 3 parts of 6.199, 2.783 and 0.917 km².
  - All 58 numbered wards are single polygons.
- **Identifiers:** `KGISWardID`, `KGISWardCo`, `LGD_WardCo` and `KGISWardNo` are each unique across 59 features.
  - Ward numbers 1–58 are complete, with no gaps or duplicates.
  - `LGD_WardCo` covers 25488–25634: 58 codes, not consecutive, plus 0 for the Cantonment.
  - **Ward names are blank** for all 58 numbered wards.
- **Ward sizes:** numbered wards range from 0.101 to 10.749 km² (median 0.603 km²).

## 4. Town vs ward comparison
Scanline raster at 5 m cells, cross-checked at 10 m. Raster areas are within 0.0005 km² (5 m) and 0.003 km² (10 m) of the exact areas.

| Measure | 5 m | 10 m |
|---|---|---|
| Ward union area | 92.1021 km² | 92.0996 km² |
| Town minus ward union | 0 | 0 |
| Ward union minus town | 0 | 0 |
| Overlap between wards | 0 | 0 |
| Gaps enclosed by the wards | 0 | 0 |
| Connected components (union / town) | 1 / 1 | 1 / 1 |
| Intersection over union, town vs wards | 1.0 | 1.0 |

The ward union equals the town polygon exactly. The exact areas are identical too, which is consistent with the town polygon having been dissolved from the ward layer. **All 58 wards are represented**, plus the Cantonment unit.

## 5. What the polygon represents
- KGIS labels it a City Corporation (`Town_Type` = CC) with the national Local Government Directory town code 251824. That is strong evidence it is **intended** to be the Belagavi City Corporation area.
- **It also contains the Cantonment.** A 9.899 km² feature named "Cantonment" (10.75% of the polygon, centred near 15.859 N, 74.501 E) is one of the 59 units. Its location agrees with OpenStreetMap's "Belagavi Cantonment" military land use (way 1119941070). The Cantonment is administered by a Cantonment Board, not the corporation. Whether its civil areas have been legally transferred is **unverified** (section 7). So the polygon is best described as **"58 corporation wards + Cantonment"**, not as the corporation's jurisdiction.
- Excluding the Cantonment, the 58 wards cover 82.203 km². I have **not** created that polygon, and I don't treat either figure as the legal municipal area.
- No publication or revision date, no notification reference and no legal authority statement come with the data. The 58-ward count matches the commonly reported figure, but it has **not** been verified against the State Election Commission's current delimitation.

## 6. Licence and use terms (KGIS downloads page)
- The data "shall not be used for any legal purpose" and must not be used "for any commercial purposes".
- It is representational and must be revalidated.

Use in this project would be internal, non-commercial research. That still needs the team's approval, and the data must never be presented as a legal boundary.

## 7. Cantonment findings
- **In KGIS:** included in the town polygon as a separate, unnumbered 59th unit (LGD ward code 0), in three parts.
- **Legal status:** **not verified.** The Cantonment Board site did not resolve, and no Ministry of Defence or Karnataka Gazette notification of an excision or transfer was found. The Cantonment must not be treated as corporation territory without that evidence. It is also not listed as a separate town in KGIS (none of the 315 town names contains "CANT").

## 8. Earlier sources, for context
| Source | Result |
|---|---|
| OpenStreetMap (Overpass, Nominatim) | No municipal polygon: district relation 2020648, taluk relation 3773898, a city **point** (node 343333679), the corporation office building, and Cantonment land use. |
| https://belagavicitycorp.org/ | Login page only. |
| https://belagavi.nic.in/ | Lists the corporation among urban local bodies (page dated 20.03.2020); no ward count, area or map. |
| State Election Commission, DMA, Cantonment Board | Hostnames tried did not resolve. |

## 9. Classification
| Candidate | Class | Evidence |
|---|---|---|
| **KGIS town polygon `0105_BELAGAVI` (Town_Type CC, LGD 251824)** | **B: official KGIS, current jurisdiction and date uncertain** | Official state publisher; labelled City Corporation; consistent with 58 wards; valid geometry. But it has no date or notification, carries a "no legal use" licence, and includes the Cantonment unit. |
| KGIS ward layer `0105_BELAGAVI` | **B** | Same publisher; complete 1–58 numbering; exact match with the town. Same date and authority gaps, and no ward names. |
| KGIS "Cantonment" feature | **D** for corporation purposes | A cantonment, not a corporation ward; legal transfer unverified. |
| OSM district, taluk, city point, land use | D | Not municipal corporation boundaries. |

Nothing is class A: no verified, current, legally notified corporation boundary was found.

## 10. Can a citywide road-sampling study proceed?
**Technically yes, as an explicitly labelled research extent, after two approvals.**
- **Candidate extent:** "Belagavi Urban Study Area (KGIS 0105 town polygon, which includes the Cantonment; not a legal municipal boundary)", 92.10 km², bounding box 15.801–15.932 N, 74.475–74.579 E.
- **Coverage gap:** 6 of the app's 8 demand-zone centres lie inside it. **VTU / Machhe and the Airport (Sambra) are outside**, as are 7 of 35 landmarks (Machhe, VTU, Piranwadi, Hindalga, Airport, Suvarna Vidhana Soudha, Kakati). A study covering the app's operating area would need those added as separately labelled extensions. Machhe is a separate KGIS town (code 0137).
- **Approval 1:** the team agrees to use KGIS data for internal non-commercial research under its terms.
- **Approval 2:** whether to include or exclude the Cantonment unit.
- **Still blocked:** the TomTom live audit, until TomTom's licence and pricing terms for this evaluation are confirmed in writing. No TomTom request has been made.

## 11. Remaining uncertainties
- Publication and revision date and legal basis of the KGIS polygon (only file timestamps of 12 Oct 2026).
- Current ward delimitation (count and boundaries) from the State Election Commission or a Gazette notification.
- Whether the LGD town code 251824 record matches this polygon's extent; the LGD directory was not consulted.
- Legal status of the Belagavi Cantonment and any transfer of civil areas.
- Ward names are absent from the data.
