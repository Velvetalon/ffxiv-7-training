import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function option(name, fallback = null) {
  const prefix = "--" + name + "=";
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function category(contentTypeId) {
  const categories = {
    2: "dungeon", 3: "other_instance", 4: "trial", 5: "raid", 6: "special",
    7: "other_instance", 9: "special", 16: "other_instance", 19: "special",
    20: "special", 21: "special", 22: "special", 23: "special", 26: "special",
    27: "special", 28: "high_end", 29: "special", 30: "special", 37: "high_end",
    38: "raid", 39: "trial", 40: "special",
  };
  return categories[Number(contentTypeId)] || "unknown";
}

function sceneKey(territory) {
  return String(territory?.[1] || "").split("/").filter(Boolean).at(-1) || null;
}

function coordinate(entrance) {
  if (!entrance?.position) return null;
  const values = [entrance.position.x, entrance.position.y, entrance.position.z];
  return values.every(Number.isFinite) ? { ...entrance.position } : null;
}

const inputDir = option("input", "tools/map-tools/data/duties");
const outputPath = option("output", "config/duties/duty-catalog.json");
const activePath = option("active", "public/extracted/active.json");
const profilesPath = option("profiles", "src/world/environment/source-profiles.json");
const lightingPath = option("lighting", "src/world/environment/source-lights.json");
const entrancesPath = option("entrances", "config/duties/entrances.json");
const includeUnnamed = process.argv.includes("--include-unnamed");
const limit = Number(option("limit")) || Infinity;

const contentFinderJson = readJson(path.join(inputDir, "ContentFinderCondition.json"));
const contentFinder = contentFinderJson.languages.zh.rows;
const territories = readJson(path.join(inputDir, "TerritoryType.json")).languages.zh.rows;
const contentTypes = readJson(path.join(inputDir, "ContentType.json")).languages.zh.rows;
const active = fs.existsSync(activePath) ? readJson(activePath) : { scenes: {} };
const profiles = fs.existsSync(profilesPath) ? readJson(profilesPath) : {};
const lightingObjects = fs.existsSync(lightingPath) ? readJson(lightingPath) : {};
const entranceFile = fs.existsSync(entrancesPath) ? readJson(entrancesPath) : { entrances: [] };
const entrances = new Map((entranceFile.entrances || []).map(entrance => [entrance.dutyKey, entrance]));

const duties = [];
const skipped = [];
for (const [rowId, row] of Object.entries(contentFinder)) {
  const territoryTypeId = Number(row[1]);
  const territory = territories[territoryTypeId];
  const targetScene = sceneKey(territory);
  const name = row[43];
  if (!territory || !targetScene || (!name && !includeUnnamed)) {
    skipped.push({ rowId, reason: !territory ? "territory" : !targetScene ? "scene" : "unnamed" });
    continue;
  }
  const englishName = contentFinderJson.languages.en?.rows?.[rowId]?.[43] || "";
  const entrance = entrances.get(slug(name));
  const builtScene = Boolean(active.scenes?.[targetScene]);
  const dutyKey = entrance?.dutyKey || slug(name) || "cfc-" + rowId;
  duties.push({
    dutyKey,
    sourceRowId: Number(rowId),
    territoryTypeId,
    instanceContentId: Number(row[2]) || null,
    nameZh: name || ("未公开地图 " + (territory[0] || targetScene)),
    nameEn: englishName,
    territoryName: territory[6] || territory[5] || territory[4] || "",
    category: category(row[45]),
    contentTypeName: contentTypes[row[45]]?.[0] || "unknown",
    level: Number(row[17]) || null,
    levelSync: Number(row[18]) || null,
    highEnd: Boolean(row[35]),
    sceneKeys: builtScene ? [targetScene] : [],
    activeScene: builtScene ? targetScene : null,
    status: { rebuildStatus: builtScene ? "built" : "pending", entranceStatus: entrance?.status || "unresolved" },
    entrance: coordinate(entrance),
    fromSceneId: entrance?.fromSceneId || null,
    environment: {
      profileId: profiles[targetScene] ? targetScene : null,
      lightingObjectId: lightingObjects[targetScene] ? targetScene : null,
    },
    bgm: { territoryBgmRowId: Number(territory[20]) || null, sceneBgmId: builtScene ? targetScene : null },
  });
  if (duties.length >= limit) break;
}

const result = {
  schemaVersion: 1,
  generatedAtUtc: new Date().toISOString(),
  source: { inputDir, clientVersion: readJson(path.join(inputDir, "probe-summary.json"))?.clientVersion || null, includeUnnamed, limit: Number.isFinite(limit) ? limit : null },
  counts: {
    duties: duties.length,
    activeScenes: duties.filter(duty => duty.activeScene).length,
    sourceEntrances: entranceFile.entrances?.length || 0,
    matchedEntrances: duties.filter(duty => duty.entrance).length,
    skipped: skipped.length,
  },
  duties,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log("duty catalog: " + result.counts.duties + " duties -> " + outputPath);
console.log("active=" + result.counts.activeScenes + " entrances=" + result.counts.matchedEntrances + "/" + result.counts.sourceEntrances + " skipped=" + result.counts.skipped);
