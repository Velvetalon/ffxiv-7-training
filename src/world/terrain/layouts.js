// Geometry is traced in ORIGINAL map pixels first. The exported layout is
// derived from those points, making its source calibration directly auditable.

const round = (value) => Math.round(value * 10) / 10;
const worldPoint = (source, [x, y]) => [round((x - source.anchor[0]) / source.scale), round((y - source.anchor[1]) / source.scale)];
const worldPoints = (source, points) => points.map((point) => worldPoint(source, point));
const tracedArea = (source, item) => ({ ...item, points: worldPoints(source, item.points) });
const tracedRoad = (source, item) => ({ ...item, points: worldPoints(source, item.points) });
const tracedPlacement = (source, item) => {
  const [x, z] = worldPoint(source, item.point);
  const { point, ...rest } = item;
  return { ...rest, x, z };
};
const tracedRoute = (source, item) => ({ ...item, via: worldPoints(source, item.via) });

const GRIDANIA_SOURCE = { image: 'work/references/gridania-map.jpg', anchor: [960, 1040], scale: 3 };
const LIMSA_SOURCE = { image: 'work/references/limsa-map.jpg', anchor: [800, 960], scale: 3 };

// These are source-image pixels, never pixels from a resized preview.
export const TRACE_PIXELS = {
  gridania: {
    source: GRIDANIA_SOURCE,
    surfaces: [
      { id: 'aetheryte-plaza', kind: 'stone', height: 0, points: [[926, 1014], [957, 1004], [992, 1018], [1002, 1048], [982, 1070], [947, 1072], [923, 1050]] },
      { id: 'carpenters-yard', kind: 'earth', height: 1, points: [[842, 995], [878, 982], [911, 997], [909, 1029], [881, 1044], [849, 1028]] },
      { id: 'adders-court', kind: 'earth', height: 2, points: [[790, 948], [828, 938], [858, 956], [856, 990], [824, 1005], [792, 986]] },
      { id: 'west-bank', kind: 'earth', height: 0, points: [[748, 1084], [778, 1078], [806, 1090], [799, 1121], [769, 1133], [744, 1116]] },
      { id: 'market-knot', kind: 'stone', height: 0, points: [[1004, 1008], [1043, 1006], [1076, 1021], [1070, 1054], [1032, 1060], [1008, 1042]] },
      { id: 'quivers-yard', kind: 'earth', height: 1, points: [[1283, 1022], [1321, 1010], [1382, 1019], [1387, 1059], [1330, 1072], [1288, 1057]] },
      { id: 'roost-terrace', kind: 'wood', height: 1, points: [[949, 1116], [994, 1105], [1029, 1130], [1034, 1174], [1002, 1190], [964, 1170]] },
      { id: 'blue-badger-forecourt', kind: 'earth', height: 0, points: [[1207, 1200], [1261, 1192], [1334, 1211], [1342, 1251], [1296, 1270], [1230, 1254]] },
    ],
    roads: [
      { id: 'aetheryte-to-carpenters', kind: 'earth', points: [[940, 1032], [913, 1027], [884, 1024]], width: 8, height: 0, endHeight: 1 },
      { id: 'carpenters-to-adders', kind: 'earth', points: [[876, 1012], [858, 998], [840, 979], [824, 968]], width: 7, height: 1, endHeight: 2 },
      { id: 'adders-to-north-old-gridania', kind: 'earth', points: [[829, 956], [864, 944], [902, 933], [942, 923], [982, 910]], width: 7, height: 2, endHeight: 0 },
      { id: 'aetheryte-to-northeast-old-gridania', kind: 'earth', points: [[978, 1027], [1005, 1014], [1040, 1006], [1082, 1006], [1124, 987], [1178, 958]], width: 8, height: 0 },
      { id: 'aetheryte-to-market-knot', kind: 'stone', points: [[982, 1033], [1006, 1032], [1035, 1032]], width: 9, height: 0 },
      { id: 'market-knot-to-quivers', kind: 'earth', points: [[1053, 1045], [1090, 1071], [1108, 1095], [1151, 1110], [1205, 1108], [1253, 1082], [1288, 1045]], width: 7, height: 0, endHeight: 1 },
      { id: 'quivers-east-yard', kind: 'earth', points: [[1288, 1045], [1320, 1040], [1363, 1040]], width: 7, height: 1 },
      { id: 'aetheryte-to-west-bank', kind: 'earth', points: [[934, 1038], [894, 1038], [851, 1032], [817, 1024], [787, 1008], [763, 1021], [760, 1063], [763, 1103]], width: 7, height: 0 },
      { id: 'west-bank-to-white-wolf', kind: 'earth', points: [[763, 1103], [754, 1124], [721, 1133], [690, 1135]], width: 7, height: 0 },
      { id: 'aetheryte-south-promenade', kind: 'stone', points: [[981, 1050], [1010, 1073], [1044, 1097], [1042, 1127], [1014, 1148]], width: 8, height: 0, endHeight: 1 },
      { id: 'roost-southeast-walk', kind: 'wood', points: [[1008, 1162], [1042, 1175], [1081, 1193], [1122, 1210], [1162, 1222], [1209, 1228]], width: 8, height: 1, endHeight: 0 },
      { id: 'blue-badger-approach', kind: 'earth', points: [[1213, 1228], [1250, 1231], [1291, 1232], [1328, 1235]], width: 8, height: 0 },
    ],
    water: [
      { id: 'black-tea-brook-west', points: [[680, 995], [731, 986], [776, 1008], [800, 1046], [789, 1082], [749, 1118], [690, 1131], [660, 1108], [668, 1041]] },
      { id: 'black-tea-brook-east', points: [[1066, 1015], [1102, 994], [1141, 1000], [1164, 1033], [1154, 1070], [1124, 1102], [1102, 1136], [1073, 1115], [1080, 1074]] },
      { id: 'jadeite-flood', points: [[882, 1160], [917, 1136], [950, 1154], [973, 1200], [1017, 1248], [1002, 1300], [892, 1300], [866, 1238]] },
    ],
    landmarks: [
      { id: 'gridania-aetheryte', name: '以太之光广场', en: 'Gridania Aetheryte Plaza', type: 'crystal', point: [960, 1040], w: 13, d: 13, height: 7, description: 'Trace origin at the Aetheryte plaza.' },
      { id: 'adders-nest', name: '双蛇党巢穴', en: "Adders' Nest", type: 'guild', point: [821, 970], w: 18, d: 13, height: 9, description: 'Northwest court, reached by the Carpenter/Adders branch.' },
      { id: 'oak-atrium', name: '橡树原木工房', en: 'Oak Atrium / Carpenters’ Guild', type: 'guild', point: [870, 1007], w: 16, d: 12, height: 7, description: 'West of the Aetheryte on the joined bank route.' },
      { id: 'figagas-gift', name: '菲嘉嘉的礼物', en: "Figaga's Gift", type: 'waterwheel', point: [818, 1038], w: 11, d: 8, height: 10, description: 'Waterwheel on the western watercourse.' },
      { id: 'market-knot', name: '十字路口', en: 'The Knot', type: 'market', point: [1042, 1030], w: 17, d: 12, height: 5, description: 'Market junction east of the Aetheryte.' },
      { id: 'quivers-hold', name: '箭术师行会', en: "Quiver's Hold / Archers’ Guild", type: 'guild', point: [1302, 1042], w: 18, d: 14, height: 11, description: 'Eastern archery compound off the east route.' },
      { id: 'roost-carline', name: '栖木旅店', en: 'The Roost / Carline Canopy', type: 'inn', point: [990, 1155], w: 18, d: 14, height: 10, description: 'Southern terrace reached from the Aetheryte and carpentry bank.' },
      { id: 'blue-badger-gate', name: '蓝獾门', en: 'Blue Badger Gate', type: 'gate', point: [1306, 1235], w: 12, d: 8, height: 8, description: 'Southeast Central Shroud threshold.' },
      { id: 'white-wolf-gate', name: '白狼门', en: 'White Wolf Gate', type: 'gate', point: [690, 1135], w: 10, d: 7, height: 6, description: 'Western exit; it is not an Old Gridania connection.' },
    ],
    exits: [
      { id: 'old-gridania-north', name: 'Old Gridania — North', point: [982, 910] },
      { id: 'old-gridania-northeast', name: 'Old Gridania — Northeast', point: [1178, 958] },
      { id: 'white-wolf', name: 'White Wolf Gate', point: [690, 1135] },
      { id: 'central-shroud', name: 'Blue Badger Gate — Central Shroud', point: [1332, 1235] },
    ],
    npcs: [
      { id: 'gridania-guide', name: '森都训练官 艾兰', point: [978, 1060], dialogue: '双蛇党在西北，白狼门在最西侧；北面和东北才通往旧格里达尼亚。' },
      { id: 'carpenter-apprentice', name: '工房学徒 索里', point: [902, 1017], dialogue: '溪畔木道接着旅店坡道，别走入水渠和林间。' },
    ],
    decorations: [
      { type: 'tree', point: [785, 940], scale: 1.6 }, { type: 'tree', point: [748, 1028], scale: 1.4 },
      { type: 'tree', point: [1183, 1018], scale: 1.5 }, { type: 'tree', point: [1360, 1090], scale: 1.45 },
      { type: 'flowers', point: [947, 1072], scale: 1.1 }, { type: 'lamp', point: [1008, 1082] },
      { type: 'lamp', point: [1100, 1200] }, { type: 'banner', point: [830, 964] },
    ],
    routes: [
      { id: 'aetheryte-to-adders', from: 'gridania-aetheryte', to: 'adders-nest', via: [[913, 1027], [858, 998]] },
      { id: 'aetheryte-to-carpenters', from: 'gridania-aetheryte', to: 'oak-atrium', via: [[913, 1027], [884, 1024]] },
      { id: 'adders-to-old-gridania-north', from: 'adders-nest', to: 'old-gridania-north', via: [[864, 944], [942, 923]] },
      { id: 'aetheryte-to-old-gridania-northeast', from: 'gridania-aetheryte', to: 'old-gridania-northeast', via: [[1005, 1014], [1082, 1006], [1124, 987]] },
      { id: 'aetheryte-to-archers', from: 'gridania-aetheryte', to: 'quivers-hold', via: [[1035, 1032], [1090, 1071], [1108, 1095], [1151, 1110], [1205, 1108], [1253, 1082], [1288, 1045]] },
      { id: 'aetheryte-to-roost', from: 'gridania-aetheryte', to: 'roost-carline', via: [[1010, 1073], [1044, 1097], [1042, 1127], [1014, 1148]] },
      { id: 'roost-to-blue-badger', from: 'roost-carline', to: 'central-shroud', via: [[1081, 1193], [1162, 1222], [1250, 1231]] },
      { id: 'aetheryte-to-white-wolf', from: 'gridania-aetheryte', to: 'white-wolf', via: [[894, 1038], [851, 1032], [817, 1024], [787, 1008], [763, 1021], [760, 1063], [763, 1103], [754, 1124], [721, 1133]] },
    ],
  },
  limsa: {
    source: LIMSA_SOURCE,
    surfaces: [
      { id: 'octant', kind: 'stone', height: 7, points: [[760, 925], [797, 912], [832, 930], [842, 970], [822, 1002], [784, 1005], [758, 976]] },
      { id: 'east-hawkers-platform', kind: 'stone', height: 7, points: [[680, 968], [728, 956], [771, 972], [778, 1010], [736, 1026], [690, 1017]] },
      { id: 'west-hawkers-platform', kind: 'stone', height: 6, points: [[500, 1005], [546, 990], [612, 1002], [634, 1035], [616, 1065], [548, 1068], [505, 1046]] },
      { id: 'mealvaans-platform', kind: 'stone', height: 5, points: [[286, 930], [332, 914], [368, 940], [370, 983], [340, 1014], [294, 1002]] },
      { id: 'ferry-landing', kind: 'wood', height: 2, points: [[170, 1015], [213, 1001], [249, 1024], [246, 1060], [210, 1084], [172, 1065]] },
      { id: 'mizzenmast-ring', kind: 'stone', height: 4, points: [[721, 1120], [761, 1102], [803, 1126], [810, 1173], [777, 1200], [732, 1193], [712, 1157]] },
      { id: 'fishers-bottom', kind: 'wood', height: 2, points: [[625, 1242], [664, 1225], [695, 1251], [691, 1304], [659, 1321], [623, 1299]] },
      { id: 'lower-round', kind: 'stone', height: 1, points: [[706, 1295], [744, 1280], [774, 1304], [778, 1344], [747, 1367], [709, 1350]] },
      { id: 'astalicia-quay', kind: 'wood', height: 0, points: [[375, 1285], [460, 1270], [560, 1281], [582, 1324], [546, 1354], [427, 1356], [372, 1331]] },
      { id: 'rogues-court', kind: 'stone', height: 1, points: [[602, 1370], [642, 1355], [684, 1373], [686, 1416], [654, 1440], [610, 1426]] },
      { id: 'bulwark-hall', kind: 'stone', height: 8, points: [[907, 928], [962, 916], [1015, 932], [1022, 973], [979, 993], [920, 984]] },
    ],
    roads: [
      { id: 'octant-to-east-hawkers', kind: 'stone', points: [[778, 989], [750, 993], [720, 997], [693, 1000]], width: 10, height: 7 },
      { id: 'east-to-west-hawkers', kind: 'stone', points: [[692, 1000], [665, 1013], [642, 1028], [620, 1040]], width: 10, height: 7, endHeight: 6 },
      { id: 'west-hawkers-main-market', kind: 'stone', points: [[620, 1040], [575, 1040], [528, 1038], [480, 1034], [430, 1034]], width: 10, height: 6 },
      { id: 'market-to-arcanists', kind: 'stone', points: [[430, 1034], [375, 1042], [328, 1042], [330, 1000], [330, 975]], width: 9, height: 6, endHeight: 5 },
      { id: 'arcanists-to-ferry', kind: 'wood', points: [[330, 975], [330, 1000], [328, 1042], [270, 1042], [210, 1045]], width: 7, height: 5, endHeight: 2 },
      { id: 'octant-to-bulwark', kind: 'stone', points: [[830, 962], [870, 960], [915, 960], [960, 960]], width: 9, height: 7, endHeight: 8 },
      { id: 'bulwark-to-zephyr', kind: 'stone', points: [[975, 960], [1018, 960], [1070, 960]], width: 8, height: 8 },
      { id: 'octant-south-east', kind: 'stone', points: [[800, 990], [835, 1040]], width: 8, height: 7, endHeight: 6 },
      { id: 'south-east-descent', kind: 'stone', points: [[835, 1040], [820, 1080], [790, 1120]], width: 8, height: 6, endHeight: 4 },
      { id: 'mizzenmast-entry', kind: 'stone', points: [[790, 1120], [803, 1150], [795, 1180], [770, 1201]], width: 8, height: 4 },
      { id: 'mizzenmast-west-link', kind: 'wood', points: [[770, 1201], [743, 1221], [718, 1243], [690, 1245], [650, 1220]], width: 8, height: 4, endHeight: 2 },
      { id: 'lower-east-rail', kind: 'wood', points: [[770, 1201], [745, 1220], [735, 1240]], width: 7, height: 4, endHeight: 2 },
      { id: 'lower-east-bridge', kind: 'wood', points: [[735, 1240], [735, 1280], [735, 1330]], width: 7, height: 2, endHeight: 1 },
      { id: 'round-to-rogues', kind: 'stone', points: [[735, 1330], [735, 1420], [690, 1420], [640, 1400]], width: 8, height: 1 },
      { id: 'hawkers-south-west-parallel', kind: 'wood', points: [[620, 1040], [590, 1085], [590, 1150], [620, 1190], [650, 1220]], width: 8, height: 6, endHeight: 2 },
      { id: 'fishers-spur', kind: 'wood', points: [[650, 1220], [660, 1260], [660, 1290]], width: 7, height: 2 },
      { id: 'fishers-to-astalicia', kind: 'wood', points: [[660, 1290], [620, 1300], [560, 1300], [500, 1320], [430, 1320]], width: 8, height: 2, endHeight: 0 },
      { id: 'fishers-to-rogues-loop', kind: 'wood', points: [[660, 1290], [690, 1320], [700, 1360], [670, 1380], [640, 1400]], width: 7, height: 2, endHeight: 1 },
    ],
    water: [{ id: 'limsa-harbor', points: [[150, 885], [1110, 885], [1110, 1470], [150, 1470]] }],
    landmarks: [
      { id: 'limsa-aetheryte', name: '以太之光广场', en: 'Limsa Lominsa Aetheryte Plaza / The Octant', type: 'crystal', point: [800, 960], w: 17, d: 17, height: 10, description: 'Trace origin at the Octant.' },
      { id: 'east-hawkers', name: '东商人街', en: "East Hawkers' Alley", type: 'market', point: [720, 990], w: 18, d: 12, height: 8, description: 'Eastern half of the westbound Hawkers market spine.' },
      { id: 'west-hawkers', name: '西商人街', en: "West Hawkers' Alley", type: 'market', point: [548, 1027], w: 24, d: 10, height: 8, description: 'Western half of the same market spine, before the south junction.' },
      { id: 'mealvaans-gate', name: '梅尔凡海关', en: "Mealvaan's Gate / Arcanists’ Guild", type: 'guild', point: [330, 975], w: 18, d: 14, height: 11, description: 'Far-west circular Arcanists platform.' },
      { id: 'ferry-docks', name: '渡轮码头', en: 'Ferry Docks', type: 'dock', point: [210, 1045], w: 20, d: 14, height: 5, description: 'Far-left ferry landing.' },
      { id: 'bulwark-hall', name: '堡垒大厅', en: 'Bulwark Hall', type: 'tower', point: [960, 960], w: 22, d: 15, height: 14, description: 'East of the Octant, at the lift and Zephyr Gate approach.' },
      { id: 'zephyr-gate', name: '和风门', en: 'Zephyr Gate', type: 'gate', point: [1070, 960], w: 12, d: 8, height: 9, description: 'Eastern Lower Decks exit marker.' },
      { id: 'crows-lift', name: '乌鸦升降机', en: "Crow's Lift", type: 'lift', point: [835, 1040], w: 10, d: 11, height: 13, description: 'Lift beside the eastern southbound deck.' },
      { id: 'mizzenmast', name: '主桅环道', en: 'Mizzenmast Ring', type: 'tower', point: [760, 1160], w: 24, d: 20, height: 13, description: 'Large stepped central ring joining the parallel southern routes.' },
      { id: 'fishers-bottom', name: '渔人之底', en: "Fisherman's Bottom / Fishermen’s Guild", type: 'guild', point: [660, 1290], w: 20, d: 17, height: 7, description: 'Southwest working quay on the western parallel route.' },
      { id: 'astalicia', name: '阿斯塔利西亚号', en: 'The Astalicia', type: 'ship', point: [430, 1320], w: 47, d: 20, height: 18, description: 'Long horizontal pirate ship west of Fisherman’s Bottom.' },
      { id: 'rogues-guild', name: '盗贼行会', en: 'The Dutiful Sisters of the Edelweiss / Rogues’ Guild', type: 'guild', point: [640, 1400], w: 26, d: 20, height: 12, description: 'South end of the eastern loop.' },
    ],
    exits: [
      { id: 'upper-decks', name: 'Crow’s Lift — Upper Decks', point: [835, 1040] },
      { id: 'middle-la-noscea', name: 'Zephyr Gate — Middle La Noscea', point: [1070, 960] },
      { id: 'western-la-noscea', name: 'Ferry / Western La Noscea', point: [210, 1045] },
    ],
    npcs: [
      { id: 'limsa-deckhand', name: '甲板员 瑞妮', point: [818, 990], dialogue: '商人街在西边；东侧通向堡垒大厅和和风门。' },
      { id: 'harbor-navigator', name: '领港员 赛拉', point: [612, 1060], dialogue: '两条南行栈道在主桅环道和渔人码头重新相连。' },
    ],
    decorations: [
      { type: 'fountain', point: [800, 960], scale: 1.1 }, { type: 'banner', point: [847, 974] },
      { type: 'crate', point: [520, 1054], scale: 0.9 }, { type: 'crate', point: [380, 1018], scale: 1.1 },
      { type: 'lamp', point: [650, 1018] }, { type: 'lamp', point: [450, 1034] },
      { type: 'lamp', point: [650, 1250] }, { type: 'crate', point: [590, 1300], scale: 1.15 },
      { type: 'banner', point: [670, 1380] },
    ],
    routes: [
      { id: 'octant-to-east-hawkers', from: 'limsa-aetheryte', to: 'east-hawkers', via: [[750, 993], [720, 997]] },
      { id: 'hawkers-to-arcanists', from: 'east-hawkers', to: 'mealvaans-gate', via: [[620, 1040], [480, 1034], [375, 1042], [328, 1042], [330, 1000]] },
      { id: 'arcanists-to-ferry', from: 'mealvaans-gate', to: 'ferry-docks', via: [[330, 1000], [328, 1042], [270, 1042]] },
      { id: 'octant-to-zephyr', from: 'limsa-aetheryte', to: 'middle-la-noscea', via: [[870, 960], [960, 960], [1018, 960]] },
      { id: 'octant-to-mizzenmast', from: 'limsa-aetheryte', to: 'mizzenmast', via: [[835, 1040], [820, 1080], [790, 1120]] },
      { id: 'hawkers-to-fishers', from: 'west-hawkers', to: 'fishers-bottom', via: [[590, 1085], [590, 1150], [650, 1220], [660, 1260]] },
      { id: 'mizzenmast-to-fishers', from: 'mizzenmast', to: 'fishers-bottom', via: [[795, 1180], [770, 1201], [743, 1221], [718, 1243], [690, 1245], [650, 1220], [660, 1260]] },
      { id: 'mizzenmast-to-rogues', from: 'mizzenmast', to: 'rogues-guild', via: [[745, 1200], [735, 1330], [735, 1420], [690, 1420]] },
      { id: 'fishers-to-astalicia', from: 'fishers-bottom', to: 'astalicia', via: [[620, 1300], [560, 1300], [500, 1320]] },
      { id: 'fishers-to-rogues-loop', from: 'fishers-bottom', to: 'rogues-guild', via: [[690, 1320], [700, 1360], [670, 1380]] },
    ],
  },
};

const buildLayout = (id, name, region, bounds, trace, spawn, dummy) => ({
  id,
  name,
  region,
  bounds,
  source: trace.source,
  spawn: tracedPlacement(trace.source, { point: spawn }),
  dummy: tracedPlacement(trace.source, { point: dummy, rotation: Math.PI }),
  surfaces: trace.surfaces.map((item) => tracedArea(trace.source, item)),
  roads: trace.roads.map((item) => tracedRoad(trace.source, item)),
  water: trace.water.map((item) => tracedArea(trace.source, item)),
  landmarks: trace.landmarks.map((item) => tracedPlacement(trace.source, item)),
  exits: trace.exits.map((item) => tracedPlacement(trace.source, item)),
  npcs: trace.npcs.map((item) => tracedPlacement(trace.source, item)),
  decorations: trace.decorations.map((item) => tracedPlacement(trace.source, item)),
  routes: trace.routes.map((item) => tracedRoute(trace.source, item)),
});

export const LAYOUTS = {
  gridania: buildLayout('gridania', '格里达尼亚新街', '黑衣森林', { minX: -105, maxX: 140, minZ: -55, maxZ: 90 }, TRACE_PIXELS.gridania, [957, 1060], [978, 1059]),
  limsa: buildLayout('limsa', '利姆萨·罗敏萨下层甲板', '拉诺西亚', { minX: -220, maxX: 105, minZ: -30, maxZ: 170 }, TRACE_PIXELS.limsa, [780, 985], [804, 985]),
};

export function getLayout(id) {
  return LAYOUTS[id] ?? LAYOUTS.gridania;
}
