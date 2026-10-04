import test from "node:test";
import assert from "node:assert/strict";
import {
  parseShape,
  parseMatrix,
  filledMatrix,
  resolveHits,
  applyChanges,
  isDead,
  rankPlacements,
  countHearts,
  VOID,
  EMPTY,
} from "../src/battle/logic/shapes.js";
import {
  createCombat,
  createRng,
  heroAttack,
  heroHeal,
  heroShield,
  heroRetreat,
  monsterTurn,
  heroTransform,
  previewAttack,
  heroWait,
  previewHeal,
  slotBlocked,
  ENERGY_START,
  ENERGY_MAX,
  ENERGY_COST,
  ENERGY_PER_LINK,
  slotOf,
  comboLinks,
  previewCombo,
  reachesChase,
  monsterHits,
  parriedCell,
  LEECH_HEAL,
} from "../src/battle/logic/combat.js";
import {
  createBoard,
  heroMove,
  advanceMonsters,
  chaseStep,
  resolveBattle,
  monsterCanStand,
  heroCanEnter,
  pickupAt,
  pickableAt,
  useForge,
  lineOfSight,
  isVisible,
  isExplored,
  visibleMonsterAt,
  key,
  previewPlate,
  armorHero,
} from "../src/battle/logic/board.js";
import { solveChain, grindTurns } from "./helpers/chainSolver.js";
import { shapeProblem, isMirrorSymmetric, isPointSymmetric, matrixGoal } from "./helpers/matrixShape.js";
import { featuresAt } from "../src/battle/data/features.js";
import { WEAPONS, STARTING_WEAPONS } from "../src/battle/data/weapons.js";
import { MONSTERS, heartsAt, variantsAt } from "../src/battle/data/monsters.js";
import { LEVELS, weaponsForLevel, skillsForLevel } from "../src/battle/data/levels.js";
import { SKILLS } from "../src/battle/data/skills.js";
import {
  DEFAULT_HERO_NAME,
  NAME_MAX_WIDTH,
  nameWidth,
  validateName,
  getHeroName,
  setHeroName,
} from "../src/battle/data/heroName.js";
import {
  weaponShape,
  distinctRotations,
  upgradeOptions,
  applyUpgrade,
  createForgeOptions,
  rerollForgeOption,
  toggleEquip,
  toggleSkill,
  SKILL_SLOTS,
  sanitizeUpgrades,
  isAdvanced,
  planAdvancedForges,
  upgradeAllowed,
  moveLoadout,
} from "../src/battle/logic/arsenal.js";
import { transformShape, shapeKey } from "../src/battle/logic/shapes.js";

/** 按稳定的 key 找章节，插入新章节时测试不用跟着改序号。 */
const at = (key) => LEVELS.findIndex((l) => l.key === key);
const level = (key) => LEVELS[at(key)];

/** 把满心阵里的几格打空（值为 0），用来摆出伤口。 */
const withHoles = (m, cells) => {
  for (const [r, c] of cells) m[r][c] = 0;
  return m;
};

const hitSet = (hits) => hits.map((h) => `${h.r},${h.c}`).sort();

test("L 型武器在 4×4 心阵的 a00 处消除 a00 a01 a10", () => {
  const m = filledMatrix(4, 4);
  const hits = resolveHits(m, WEAPONS.hook.shape, 0, 0);
  assert.deepEqual(hitSet(hits), ["0,0", "0,1", "1,0"]);
  const next = applyChanges(m, hits);
  assert.equal(countHearts(next).hearts, 13);
});

test("形状不旋转不镜像，越界部分直接忽略", () => {
  const m = filledMatrix(4, 4);
  assert.deepEqual(hitSet(resolveHits(m, WEAPONS.hook.shape, 3, 3)), ["3,3"]);
  assert.deepEqual(hitSet(resolveHits(m, WEAPONS.hook.shape, -1, 1)), ["0,1"]);
  assert.deepEqual(hitSet(resolveHits(m, WEAPONS.hook.shape, 2, 3)), [
    "2,3",
    "3,3",
  ]);
  assert.equal(resolveHits(m, WEAPONS.hook.shape, 5, 5).length, 0);
});

test("无心槽与已空的格子不会被计入命中", () => {
  const m = parseMatrix([".#.", "###", ".#."]);
  assert.equal(m[0][0], VOID);
  const hits = resolveHits(m, parseShape(["@#", "##"]), 0, 0);
  assert.deepEqual(hitSet(hits), ["0,1", "1,0", "1,1"]);
  const after = applyChanges(m, hits);
  assert.equal(resolveHits(after, WEAPONS.dagger.shape, 0, 0).length, 0);
});

test("护甲心需要两次命中，破甲锥一次击碎", () => {
  const m = parseMatrix(["A", "A"]);
  const once = applyChanges(m, resolveHits(m, WEAPONS.spear.shape, 0, 0));
  assert.deepEqual(once, [[1], [1]]);
  const pierced = applyChanges(m, resolveHits(m, WEAPONS.awl.shape, 0, 0, WEAPONS.awl));
  assert.ok(isDead(pierced));
});

test("锚点默认取最靠近中心的命中格，也可用 @ 指定", () => {
  assert.deepEqual(parseShape(["#.#"]).pivot, [0, 0]);
  assert.deepEqual(parseShape([".#.", "###", ".#."]).pivot, [1, 1]);
  assert.deepEqual(WEAPONS.spear.shape.pivot, [1, 0], "长枪以中间一格为锚点");
  assert.deepEqual(WEAPONS.hook.shape.pivot, [0, 0], "钩镰以左上角为锚点");
});

test("怪物瞄准会优先选择伤害最高的落点", () => {
  const m = parseMatrix(["...", ".##", ".#."]);
  const best = rankPlacements(m, WEAPONS.hook.shape)[0];
  assert.equal(best.damage, 3);
  assert.deepEqual([best.r, best.c], [1, 1]);
});

test("战斗流程：主角出招 → 怪物行动 → 冷却递减 → 胜利", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger", "hook"], potions: 1 },
    monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues },
    rng: createRng(7),
  });
  assert.equal(combat.phase, "hero");
  assert.equal(heroAttack(combat, "hook", 0, 1).ok, true);
  assert.equal(combat.phase, "monster");
  monsterTurn(combat);
  assert.equal(combat.phase, "hero");
  assert.equal(combat.weapons[1].cd, 1, "冷却 1：下一个己方回合不可用");
  assert.equal(heroAttack(combat, "hook", 1, 1).ok, false);
  assert.equal(countHearts(combat.heroMatrix).hearts, 14);
  assert.equal(heroAttack(combat, "dagger", 5, 5).ok, false);
  assert.equal(heroAttack(combat, "dagger", 2, 1).ok, true);
  monsterTurn(combat);
  assert.equal(combat.weapons[1].cd, 0, "再过一回合恢复");
  while (combat.phase !== "won") {
    const target = rankPlacements(combat.monsterMatrix, WEAPONS.dagger.shape)[0];
    heroAttack(combat, "dagger", target.r, target.c);
    if (combat.phase === "monster") monsterTurn(combat);
  }
  assert.ok(isDead(combat.monsterMatrix));
});

test("暗王的「将军」让有冷却的武器延后几回合，短剑不受影响", () => {
  const step = MONSTERS.king.pattern.findIndex((p) => p.kind === "curse");
  const { amount } = MONSTERS.king.pattern[step];
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "hook"], potions: 0 },
    monster: { def: MONSTERS.king, matrix: MONSTERS.king.matrixValues, step },
    rng: createRng(4),
  });
  assert.equal(combat.intent.kind, "curse");
  heroAttack(combat, "dagger", 2, 0);
  monsterTurn(combat);
  assert.equal(combat.weapons[0].cd, 0);
  assert.equal(combat.weapons[1].cd, amount);
});

test("防御不消耗回合并挡下一次攻击；药水恢复十字范围", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(3, 3), weapons: ["dagger"], potions: 1 },
    monster: { def: MONSTERS.pawn, matrix: MONSTERS.pawn.matrixValues },
    rng: createRng(3),
  });
  assert.equal(heroShield(combat).ok, true);
  assert.equal(combat.phase, "hero");
  heroAttack(combat, "dagger", 1, 0);
  monsterTurn(combat);
  assert.equal(countHearts(combat.heroMatrix).hearts, 9);
  assert.equal(heroShield(combat).ok, false);
  heroAttack(combat, "dagger", 2, 0);
  monsterTurn(combat);
  const lost = 9 - countHearts(combat.heroMatrix).hearts;
  assert.ok(lost > 0);
  const hole = combat.heroMatrix.flatMap((row, r) => row.map((v, c) => ({ v, r, c }))).find((x) => x.v === 0);
  assert.equal(heroHeal(combat, hole.r, hole.c).ok, true);
  assert.equal(combat.potions, 0);
});

test("撤退时怪物追击一次，暗王战无法撤退", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger"], potions: 0 },
    monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues },
    rng: createRng(1),
  });
  assert.equal(heroRetreat(combat).ok, true);
  monsterTurn(combat);
  assert.equal(combat.phase, "fled");
  const boss = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger"], potions: 0 },
    monster: { def: MONSTERS.king, matrix: MONSTERS.king.matrixValues },
  });
  assert.equal(heroRetreat(boss).ok, false);
});

function reachable(board, from) {
  const seen = new Set([key(from.r, from.c)]);
  const queue = [from];
  while (queue.length) {
    const { r, c } = queue.shift();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= board.rows || nc >= board.cols) continue;
      const item = board.items.get(key(nr, nc));
      if (board.tiles[nr][nc].prop || seen.has(key(nr, nc))) continue;
      if (item && item.type === "forge") continue;
      seen.add(key(nr, nc));
      queue.push({ r: nr, c: nc });
    }
  }
  return seen;
}

test("每一关都是 8 列、8 行（终章的大厅长一半，12 行），出口、宝箱、钥匙、药水、铁砧都能走到", () => {
  LEVELS.forEach((level, index) => {
    const board = createBoard(level, { weapons: weaponsForLevel(index, STARTING_WEAPONS) });
    assert.equal(board.cols, 8, level.name);
    assert.equal(board.rows, level.key === "checkmate" ? 12 : 8, level.name);
    level.map.forEach((row) => assert.equal(row.replace(/\s+/g, "").length, 8, level.name));
    const seen = reachable(board, board.hero);
    assert.ok(seen.has(key(board.exit.r, board.exit.c)), `${level.name} 出口不可达`);
    for (const item of board.items.values()) {
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => seen.has(key(item.r + dr, item.c + dc)));
      const ok = item.type === "key" ? seen.has(key(item.r, item.c)) : near;
      assert.ok(ok, `${level.name} 道具 ${item.type} 无法拾取`);
    }
    for (const m of board.monsters) {
      assert.ok(!board.tiles[m.r][m.c].prop, `${level.name} 怪物站在障碍上`);
      if (m.path) m.path.forEach(([r, c]) => assert.ok(!board.tiles[r][c].prop));
    }
  });
});

test("走进怪物格子会由主角先手开战，胜利后占据该格", () => {
  const board = createBoard(level("first-blot"), { weapons: STARTING_WEAPONS });
  for (const [r, c] of [[6, 3], [6, 4], [6, 5], [6, 6]]) assert.equal(heroMove(board, r, c).kind, "moved");
  const fight = heroMove(board, 5, 6);
  assert.equal(fight.kind, "battle");
  assert.equal(fight.heroFirst, true);
  const combat = createCombat({ hero: board.hero, monster: fight.monster, rng: createRng(2) });
  while (combat.phase !== "won") {
    const target = rankPlacements(combat.monsterMatrix, WEAPONS.dagger.shape)[0];
    heroAttack(combat, "dagger", target.r, target.c);
    if (combat.phase === "monster") monsterTurn(combat);
  }
  resolveBattle(board, fight.monster, combat, true);
  assert.deepEqual([board.hero.r, board.hero.c], [5, 6]);
  assert.equal(fight.monster.alive, false);
});

test("骑士按马步追击，扑到主角时触发突袭", () => {
  const board = createBoard(level("knight-watch"), { weapons: STARTING_WEAPONS });
  const knight = board.monsters.find((m) => m.def.id === "knight");
  board.hero.r = 5;
  board.hero.c = 5;
  const step = chaseStep(board, knight);
  assert.deepEqual(step, { r: 5, c: 5 });
  const outcome = advanceMonsters(board);
  assert.equal(outcome.ambush, knight);
});

test("怪物不会踏上道具、门和出口", () => {
  const board = createBoard(level("knight-watch"), { weapons: STARTING_WEAPONS });
  assert.equal(monsterCanStand(board, 0, 7), false);
  assert.equal(monsterCanStand(board, 1, 0), false);
  assert.equal(monsterCanStand(board, 0, 0), false);
});

test("钥匙打开铁栅门；暗王被击败后出口才开放", () => {
  const board = createBoard(level("knight-watch"), { weapons: STARTING_WEAPONS });
  board.hero.r = 2;
  board.hero.c = 1;
  board.monsters[0].alive = false;
  board.hero.r = 2;
  board.hero.c = 0;
  assert.equal(heroMove(board, 1, 0).kind, "blocked");
  board.hero.keys = 1;
  assert.equal(heroMove(board, 1, 0).kind, "moved");
  assert.equal(board.doors.size, 0);
  assert.equal(heroMove(board, 0, 0).events.at(-1).type, "exit");

  const final = createBoard(level("checkmate"), { weapons: STARTING_WEAPONS });
  assert.equal(final.exitOpen, false);
  const king = final.monsters.find((m) => m.def.boss);
  resolveBattle(final, king, { heroMatrix: final.hero.matrix, monsterMatrix: king.matrix, potions: 0, step: 0, phase: "won", stats: { taken: 0 } }, false);
  assert.equal(final.exitOpen, true);
});

test("宝箱和药水走上去就拿到，拿完格子空出来；铁砧要站在旁边点", () => {
  const board = createBoard(level("first-blot"), { weapons: [...STARTING_WEAPONS] });
  heroMove(board, 7, 2);
  heroMove(board, 7, 1);
  const moved = heroMove(board, 6, 1);
  assert.ok(moved.events.some((e) => e.type === "pickup" && e.item.type === "chest"), "走上宝箱就打开");
  assert.ok(board.hero.weapons.includes("slash"));
  assert.equal(board.items.has(key(6, 1)), false, "拿完宝箱格子空出来");
  const potions = board.hero.potions;
  board.hero.r = 6;
  board.hero.c = 6;
  assert.ok(heroMove(board, 6, 7).events.some((e) => e.type === "pickup" && e.item.type === "potion"));
  assert.equal(board.hero.potions, potions + 1);
  assert.equal(board.items.has(key(6, 7)), false);
  const again = createBoard(level("first-blot"), { weapons: [...STARTING_WEAPONS, "slash"] });
  assert.equal(again.items.has(key(6, 1)), false, "重玩时拿过的宝箱不再出现");
  const hall = createBoard(level("bishop-hall"), { weapons: [...STARTING_WEAPONS] });
  const forge = [...hall.items.values()].find((it) => it.type === "forge");
  assert.equal(heroCanEnter(hall, forge.r, forge.c).ok, false, "铁砧不能踩上");
});

test("视线会被障碍挡住", () => {
  const custom = {
    ...level("first-blot"),
    map: [
      "E . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      "S b . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
      ". . . . . . . .",
    ],
    monsters: [],
  };
  const board = createBoard(custom, { weapons: STARTING_WEAPONS });
  assert.equal(lineOfSight(board, { r: 4, c: 0 }, { r: 4, c: 2 }), false);
  assert.equal(lineOfSight(board, { r: 4, c: 0 }, { r: 4, c: 1 }), true, "障碍本身看得见");
  assert.equal(lineOfSight(board, { r: 4, c: 0 }, { r: 2, c: 0 }), true);
});

test("战争迷雾：只显示视野内的格子与怪物，走过的区域留下记忆，出口始终可见", () => {
  const board = createBoard(level("rook-wall"), { weapons: STARTING_WEAPONS });
  assert.ok(board.fog);
  assert.ok(isVisible(board, 7, 4), "自己脚下可见");
  assert.equal(isVisible(board, 0, 7), false);
  assert.ok(isExplored(board, board.exit.r, board.exit.c), "出口作为地标始终已探索");
  const knight = board.monsters.find((m) => m.def.id === "knight");
  assert.equal(visibleMonsterAt(board, knight.r, knight.c), null, "迷雾中的怪物看不见");
  assert.equal(knight.seen, false);
  heroMove(board, 7, 5);
  assert.ok(isExplored(board, 7, 3), "离开后仍记得来时的路");
  const noFog = createBoard(LEVELS[1], { weapons: STARTING_WEAPONS });
  assert.equal(noFog.fog, null);
  assert.ok(isVisible(noFog, 0, 0));
});

test("变形：绕锚点旋转与镜像；战锤和圣十字没有变形强化，其余可变形的武器变形后确实不同", () => {
  const hook = WEAPONS.hook.shape;
  assert.deepEqual(hitSet(resolveHits(filledMatrix(4, 4), transformShape(hook, { flip: true }), 0, 1)), ["0,0", "0,1", "1,1"]);
  // 顺时针转 90°：L 形从“右、下”变成“下、左”。
  assert.deepEqual(hitSet(resolveHits(filledMatrix(4, 4), transformShape(hook, { rot: 1 }), 1, 1)), ["1,0", "1,1", "2,1"]);
  for (const [id, weapon] of Object.entries(WEAPONS)) {
    if (id === "hammer" || id === "cross") assert.deepEqual(weapon.transforms, [], id);
    for (const kind of weapon.transforms) {
      const changed = kind === "rotate" ? { rot: 1 } : { flip: true };
      assert.notEqual(shapeKey(transformShape(weapon.shape, changed)), shapeKey(weapon.shape), `${id} ${kind}`);
    }
  }
  assert.deepEqual(distinctRotations("dagger", { dagger: { rotate: true } }), [0, 1], "短剑只有横竖两种");
  assert.equal(distinctRotations("hook", { hook: { rotate: true } }).length, 4);
});

test("强化：延长可切换为加长形状；候选项不会重复已有的强化；强化会带进战斗", () => {
  // 中型武器延长一格；重武器延长得更多（战锤 +2，圣十字 +4）；轻武器不能延长。
  for (const [id, weapon] of Object.entries(WEAPONS))
    if (weapon.weight === "medium") assert.equal(weapon.plusShape.size, weapon.shape.size + 1, id);
  assert.equal(WEAPONS.hammer.shape.size, 4, "战锤 2×2");
  assert.equal(WEAPONS.hammer.plusShape.size, 6, "延长后 2×3");
  assert.equal(WEAPONS.cross.shape.size, 5);
  assert.equal(WEAPONS.cross.plusShape.size, 9);
  const hero = { weapons: ["dagger", "hook", "hammer"], upgrades: {} };
  const all = upgradeOptions(hero, createRng(1), 20).map((o) => `${o.weapon}:${o.kind}`);
  const basic = all.filter((k) => !isAdvanced(k.split(":")[1])).sort();
  assert.deepEqual(
    basic,
    [
      "dagger:leech",
      "dagger:parry",
      "dagger:precise",
      "dagger:rotate",
      "hammer:extend",
      "hammer:pierce",
      "hammer:stagger",
      "hook:extend",
      "hook:mirror",
      "hook:pierce",
      "hook:rotate",
    ],
    "基础强化补短板：轻武器精准、招架、吸血；中型延长、破甲；重武器延长、震慑、破甲（旋转、镜像看武器本身）",
  );
  assert.equal(all.filter((k) => isAdvanced(k.split(":")[1])).length, 0, "没排到进阶强化的铁砧只出基础强化");
  const rare = upgradeOptions(hero, createRng(1), 20, {}, { advanced: true }).filter((o) => isAdvanced(o.kind));
  assert.equal(rare.length, 1, "排到进阶强化的铁砧：整组恰好一个");
  assert.ok(["dagger:chain", "dagger:doom", "hammer:quake"].includes(`${rare[0].weapon}:${rare[0].kind}`));
  applyUpgrade(hero, { weapon: "dagger", kind: "rotate" });
  assert.equal(upgradeOptions(hero, createRng(1), 10).some((o) => o.weapon === "dagger" && o.kind === "rotate"), false);
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger"], potions: 0, upgrades: hero.upgrades },
    monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues },
    rng: createRng(2),
  });
  assert.equal(heroTransform(combat, "dagger", "mirror").ok, false, "没有镜像强化");
  assert.equal(heroTransform(combat, "dagger", "rotate").ok, true);
  assert.deepEqual(hitSet(previewAttack(combat, "dagger", 0, 1)), ["0,1", "1,1"], "旋转后变成竖向两格");
  // 延长是开关：默认仍是原形状，切换后才用加长形状。
  assert.equal(weaponShape("hook", { hook: { extend: true } }).size, 3, "默认原形状");
  assert.equal(weaponShape("hook", { hook: { extend: true } }, { ext: true }).size, 4, "切换后加长");
  assert.equal(weaponShape("hook", {}, { ext: true }).size, 3, "没有延长强化时切换无效");
});

test("延长：战斗中不占回合地切换长短，可以随时切回原形状", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["spear"], potions: 0, upgrades: { spear: { extend: true } } },
    monster: { def: MONSTERS.pawn, matrix: parseMatrix(["####", "####", "####", "####"]) },
    rng: createRng(1),
  });
  assert.equal(previewAttack(combat, "spear", 1, 0).length, 3, "默认纵向三格");
  assert.equal(heroTransform(combat, "spear", "extend").ok, true);
  assert.equal(combat.phase, "hero", "切换不消耗回合");
  assert.equal(previewAttack(combat, "spear", 1, 0).length, 4, "加长后四格");
  heroTransform(combat, "spear", "extend");
  assert.equal(previewAttack(combat, "spear", 1, 0).length, 3, "切回原形状");
  const plain = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["spear"], potions: 0 },
    monster: { def: MONSTERS.pawn, matrix: MONSTERS.pawn.matrixValues },
    rng: createRng(1),
  });
  assert.equal(heroTransform(plain, "spear", "extend").ok, false, "没有延长强化");
});

test("技能：次数有限；突刺后可以立刻再用一次普通武器；定身让怪物跳过一次行动；汲血恢复红心", () => {
  const make = (skills, heroMatrix = filledMatrix(4, 4)) =>
    createCombat({
      hero: { matrix: heroMatrix, weapons: ["dagger"], potions: 0, skills },
      monster: { def: MONSTERS.pawn, matrix: MONSTERS.pawn.matrixValues },
      rng: createRng(5),
    });
  const swift = make({ swift: 1 });
  assert.equal(heroAttack(swift, "swift", 1, 0).ok, true);
  assert.equal(swift.phase, "hero", "突刺之后仍是主角回合");
  assert.equal(heroAttack(swift, "swift", 2, 0).ok, false, "次数用完");
  assert.equal(heroAttack(swift, "dagger", 2, 0).ok, true);
  assert.equal(swift.phase, "monster", "追加攻击之后轮到怪物");

  const stun = make({ stun: 1 });
  const stepBefore = stun.step;
  heroAttack(stun, "stun", 1, 1);
  const hearts = countHearts(stun.heroMatrix).hearts;
  monsterTurn(stun);
  assert.equal(countHearts(stun.heroMatrix).hearts, hearts, "被定身的怪物没有攻击");
  assert.equal(stun.step, stepBefore, "招式顺序不前进");

  const hurt = filledMatrix(4, 4);
  hurt[0][0] = 0;
  hurt[0][1] = 0;
  const drain = make({ drain: 1 }, hurt);
  heroAttack(drain, "drain", 1, 1);
  assert.equal(countHearts(drain.heroMatrix).hearts, 16, "消除 3 颗，恢复 2 个空位");
});

test("技能按章节解锁，每章开始时次数恢复；铁砧选定强化后才算用掉", () => {
  assert.deepEqual(skillsForLevel(at("pawn-line"), SKILLS), {});
  assert.deepEqual(skillsForLevel(at("knight-watch"), SKILLS), { swift: 2 });
  assert.deepEqual(skillsForLevel(at("checkmate"), SKILLS), { swift: 2, stun: 1, crush: 2, meteor: 1, drain: 1 });
  const board = createBoard(level("bishop-hall"), { weapons: weaponsForLevel(at("bishop-hall"), STARTING_WEAPONS) });
  const forge = [...board.items.values()].find((i) => i.type === "forge");
  board.hero.r = forge.r + 1;
  board.hero.c = forge.c;
  assert.equal(pickupAt(board, forge.r, forge.c).events[0].type, "forge");
  assert.equal(pickupAt(board, forge.r, forge.c).ok, true, "未选择前可以再次打开");
  useForge(board, forge.r, forge.c);
  assert.equal(pickupAt(board, forge.r, forge.c).ok, false, "铁砧只能用一次");
});

test("连击与充能：每连上一次得 ENERGY_PER_LINK 点；中型花 1 点，重型花 2 点，开局抡不动，连上一下就能抡", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash", "hook", "hammer"], potions: 0 },
    monster: { def: MONSTERS.knight, matrix: parseMatrix(["#######", "#######", "#######", "#######", "#######"]) },
    rng: createRng(3),
  });
  assert.equal(combat.energy, ENERGY_START);
  assert.ok(ENERGY_COST.heavy > ENERGY_START, "重武器比开局的充能贵");
  assert.ok(ENERGY_START + ENERGY_PER_LINK >= ENERGY_COST.heavy, "连上一次就攒够重武器的充能");
  assert.match(slotBlocked(combat, slotOf(combat, "hammer")), /充能/, "开局不能直接抡战锤");
  heroAttack(combat, "dagger", 0, 0);
  assert.equal(combat.combo, 1, "起手");
  assert.equal(combat.energy, ENERGY_START, "起手不给充能");
  monsterTurn(combat);
  heroAttack(combat, "slash", 1, 0);
  assert.equal(combat.combo, 2, "连击");
  assert.equal(combat.energy, ENERGY_START + ENERGY_PER_LINK, "第一次连击就给充能");
  monsterTurn(combat);
  assert.equal(slotBlocked(combat, slotOf(combat, "hammer")), null, "攒够了，战锤可以出手");
  heroAttack(combat, "dagger", 2, 2);
  assert.equal(combat.combo, 3, "连击 ×2");
  assert.equal(combat.energy, Math.min(ENERGY_MAX, ENERGY_START + 2 * ENERGY_PER_LINK), "每连上一次都给");
  assert.equal(combat.phase, "monster", "×2 还不追击");
  monsterTurn(combat);
  const before = combat.energy;
  heroAttack(combat, "hammer", 1, 4);
  assert.equal(combat.energy, Math.min(ENERGY_MAX, before - ENERGY_COST.heavy + ENERGY_PER_LINK), "战锤连上：先花后得");
  combat.energy = 0;
  combat.weapons[2].cd = 0;
  assert.match(slotBlocked(combat, combat.weapons[2]), /充能/, "钩镰充能不足时无法使用");
  assert.equal(slotBlocked(combat, combat.weapons[0]), null, "轻武器不消耗充能");
});

test("追击：连击 ×3、×6 时怪物行动前再出一招；追击中不会再触发追击", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0 },
    monster: { def: MONSTERS.pawn, matrix: parseMatrix(["########", "########", "########", "########"]) },
    rng: createRng(5),
  });
  // 短剑、斜刃轮换，顺着心阵往右下方拼：每一击都紧挨上一击。
  const route = [["dagger", 0, 0], ["slash", 1, 0], ["dagger", 2, 2], ["slash", 1, 3]];
  for (const [id, r, c] of route.slice(0, 3)) {
    heroAttack(combat, id, r, c);
    monsterTurn(combat);
  }
  assert.equal(comboLinks(combat.combo), 2);
  const res = heroAttack(combat, ...route[3]);
  assert.equal(comboLinks(combat.combo), 3);
  assert.ok(res.events.some((e) => e.type === "combo" && e.chase), "连击 ×3 触发追击");
  assert.equal(combat.phase, "hero", "怪物还没行动");
  assert.equal(combat.bonusReason, "chase");
  heroAttack(combat, "dagger", 2, 5);
  assert.equal(comboLinks(combat.combo), 4, "追击也能接着连");
  assert.equal(combat.phase, "monster", "追击之后轮到怪物");

  // 追击中即使连到 ×6 也不会再追击。
  combat.phase = "hero";
  combat.combo = 6;
  combat.bonus = true;
  combat.bonusReason = "chase";
  const again = heroAttack(combat, "slash", 1, 6);
  assert.equal(comboLinks(combat.combo), 6);
  assert.equal(again.events.find((e) => e.type === "combo").chase, false);
  assert.equal(combat.phase, "monster");
  assert.ok(reachesChase(5, 6) && reachesChase(2, 4) && !reachesChase(3, 5));
});

test("轻武器强化：连锁让连击多涨一次；招架接上连击时怪物下一招少打 1 颗心；不再有不必紧挨上一击的强化", () => {
  const make = (upgrades) =>
    createCombat({
      hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0, upgrades },
      monster: { def: MONSTERS.pawn, matrix: parseMatrix(["######", "######", "######", "######"]) },
      rng: createRng(5),
    });
  const chained = make({ slash: { chain: true } });
  heroAttack(chained, "dagger", 0, 0);
  chained.phase = "hero";
  heroAttack(chained, "slash", 1, 0);
  assert.equal(comboLinks(chained.combo), 2, "连锁：一次连上算两次");

  const plain = make({});
  heroAttack(plain, "dagger", 0, 0);
  plain.phase = "hero";
  assert.equal(previewCombo(plain, "slash", 2, 4), "start", "离得远：重新起手");
  assert.deepEqual(sanitizeUpgrades({ dagger: { nimble: true, rotate: true } }), { dagger: { rotate: true } }, "旧存档里的灵巧被去掉");

  // 吸血：用带吸血的武器打出追击（连击 ×3 之后多出的那一击）回复 2 颗心；平常出手不回复。
  const makeLeech = () => {
    const state = createCombat({
      hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0, upgrades: { dagger: { leech: true } } },
      monster: { def: MONSTERS.pawn, matrix: parseMatrix(["######", "######", "######", "######"]) },
      rng: createRng(5),
    });
    for (const [r, c] of [[0, 0], [0, 1], [0, 2]]) state.heroMatrix[r][c] = EMPTY;
    return state;
  };
  const calm = makeLeech();
  heroAttack(calm, "dagger", 0, 0);
  assert.equal(countHearts(calm.heroMatrix).hearts, 22, "不是追击：不回复");
  const chasing = makeLeech();
  chasing.bonus = true;
  chasing.bonusReason = "chase";
  const leeched = heroAttack(chasing, "dagger", 0, 0);
  assert.equal(countHearts(chasing.heroMatrix).hearts, 22 + LEECH_HEAL, `追击时回复 ${LEECH_HEAL} 颗心`);
  assert.ok(leeched.events.some((e) => e.type === "heal" && e.side === "hero"));

  // 旧存档里的垫步换成取代它的招架。
  assert.deepEqual(sanitizeUpgrades({ dagger: { relay: true } }), { dagger: { parry: true } }, "垫步迁移为招架");

  // 招架：短剑起手、带招架的斜刃接上连击，怪物这一招少打 1 颗心；一回合接上几次也只少 1 颗。
  const makeParry = (upgrades) => {
    const state = createCombat({
      hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0, upgrades },
      monster: { def: MONSTERS.pawn, matrix: parseMatrix(["######", "######", "######", "######"]) },
      rng: createRng(5),
    });
    heroAttack(state, "dagger", 0, 0);
    state.phase = "hero";
    heroAttack(state, "slash", 1, 0);
    return state;
  };
  const guarded = makeParry({ slash: { parry: true } });
  const bare = makeParry({});
  assert.equal(guarded.parried, true, "接上连击后进入招架");
  for (const state of [guarded, bare]) {
    state.intent = { kind: "attack", name: "测试", shape: parseShape(["##", "##"]) };
    state.aim = { r: 0, c: 0 };
  }
  assert.equal(monsterHits(guarded).length, monsterHits(bare).length - 1, "招架：少打 1 颗心");
  assert.ok(parriedCell(guarded), "能指出保住的是哪一格");
  guarded.phase = "monster";
  monsterTurn(guarded);
  assert.equal(countHearts(guarded.heroMatrix).hearts, 25 - 3, "实际只失去 3 颗");
  assert.equal(guarded.parried, false, "招架只管下一招");
});

test("进阶强化：死灭抹去格子、贯通沿直线延伸、巨化再大一档、震地打断后晕眩", () => {
  // 死灭：只在接上连击的那一击生效。起手的第一击照常打掉；换一件武器挨着它再打，接上连击时被短剑消除的两格变成空位。
  const doom = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["hook", "dagger"], potions: 0, upgrades: { dagger: { doom: true } } },
    monster: { def: MONSTERS.bishop, matrix: parseMatrix(["####", "####", "####"]) },
    rng: createRng(2),
  });
  const opener = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger"], potions: 0, upgrades: { dagger: { doom: true } } },
    monster: { def: MONSTERS.bishop, matrix: parseMatrix(["####", "####"]) },
    rng: createRng(2),
  });
  const quiet = heroAttack(opener, "dagger", 0, 0);
  assert.equal(opener.monsterMatrix[0][0], EMPTY, "起手的第一击：只是普通地打掉");
  assert.ok(!quiet.events.some((e) => e.type === "doom"));
  heroAttack(doom, "hook", 1, 0);
  doom.phase = "hero";
  const result = heroAttack(doom, "dagger", 0, 0);
  assert.equal(doom.monsterMatrix[0][0], VOID, "接上连击时消除的格子被抹去");
  assert.deepEqual(doom.doomed, [[0, 0], [0, 1]], "记下被抹去的格子，界面在原位置画 ×");
  assert.ok(result.events.some((e) => e.type === "doom"));
  assert.equal(countHearts(doom.monsterMatrix).slots, 10, "心阵少了两格");

  // 贯通：长枪（纵向三格）落在一整列红心上，一直打到空位为止；落空时不延伸。
  const line = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["spear"], potions: 0, upgrades: { spear: { line: true } } },
    monster: { def: MONSTERS.rook, matrix: parseMatrix(["#.", "#.", "#.", "#.", "#.", ".#"]) },
    rng: createRng(2),
  });
  assert.equal(previewAttack(line, "spear", 1, 0).length, 5, "从两端延伸，整列五格");
  assert.equal(previewCombo(line, "spear", 1, 0), "start", "延伸出来的格子都是红心，不算落空");
  assert.equal(previewAttack(line, "spear", 4, 0).length, 2, "有一格落在空位上：照常判定，不延伸");
  assert.ok(!upgradeAllowed("hook", "line"), "钩镰不是直线，拿不到贯通");

  // 巨化：先有延长才会刷出；延长按钮在 原形状 → 延长 → 巨化 之间循环。
  assert.ok(!upgradeAllowed("hammer", "giant", {}, {}), "没有延长时不出巨化");
  assert.ok(upgradeAllowed("hammer", "giant", {}, { hammer: { extend: true } }));
  const giant = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["hammer"], potions: 0, upgrades: { hammer: { extend: true, giant: true } } },
    monster: { def: MONSTERS.pawn, matrix: filledMatrix(4, 5) },
    rng: createRng(2),
  });
  // 延长、巨化各是一个开关：按下切到那一档，再按一次回到原形状；两枚按钮可以直接互相切换。
  const size = () => previewAttack(giant, "hammer", 0, 0).length;
  const sizes = [size()];
  for (const kind of ["extend", "giant", "extend", "extend", "giant", "giant"]) {
    heroTransform(giant, "hammer", kind);
    sizes.push(size());
  }
  assert.deepEqual(sizes, [4, 6, 12, 6, 4, 12, 4], "原 2×2 → 延长 2×3 → 巨化 3×4 → 延长 → 关掉 → 巨化 → 关掉");

  // 震地：打断重击时怪物额外晕眩一回合。
  const step = MONSTERS.knight.pattern.findIndex((p) => p.kind === "charge") + 1;
  const quake = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["hammer"], potions: 0, upgrades: { hammer: { quake: true } } },
    monster: { def: MONSTERS.knight, matrix: parseMatrix(["####", "####", "####"]), step },
    rng: createRng(1),
  });
  quake.energy = ENERGY_MAX;
  heroAttack(quake, "hammer", 0, 0);
  assert.equal(quake.stunned, true, "打断之后再晕眩一回合");
});

test("进阶强化稀有：从开始到通关一共出现 1～3 次，期望 2 次，分散在终章之前的铁砧里", () => {
  // 和 main.js 的 PLANNED_FORGES 一致：终章的铁砧不排进阶强化。
  const anvils = (level) => level.map.join("").split("U").length - 1;
  const total = LEVELS.reduce((n, level) => n + anvils(level), 0) - anvils(LEVELS.at(-1));
  const rng = createRng(11);
  const runs = 4000;
  let sum = 0;
  const firstHalf = [0, 0];
  for (let i = 0; i < runs; i += 1) {
    const plan = planAdvancedForges({ total }, rng);
    assert.ok(plan.length >= 1 && plan.length <= 3, `一局出现 ${plan.length} 次`);
    assert.equal(new Set(plan).size, plan.length, "不会两次排在同一座铁砧上");
    assert.ok(plan.every((k, j) => k >= 0 && k < total && (j === 0 || k > plan[j - 1])), "按使用顺序升序、都在整局范围内");
    sum += plan.length;
    firstHalf[plan[0] < total / 2 ? 0 : 1] += 1;
  }
  const mean = sum / runs;
  assert.ok(Math.abs(mean - 2) < 0.05, `期望 2 次，实际平均 ${mean}`);
  assert.ok(firstHalf[0] > firstHalf[1], "第一次进阶强化多半出现在前半程");
  // 旧存档中途接入：已经拿到的进阶强化计入总数，排在还没用过的铁砧上。
  for (let i = 0; i < 200; i += 1) {
    const plan = planAdvancedForges({ total, used: 6, owned: 1 }, rng);
    assert.ok(plan.length <= 2 && plan.every((k) => k >= 6));
  }
  // 刷新不会多出或弄丢进阶强化：进阶只刷成进阶，基础只刷成基础。
  const hero = { weapons: ["dagger", "hook", "hammer"], upgrades: { hammer: { extend: true } } };
  const options = createForgeOptions(hero, createRng(3), {}, { advanced: true });
  const at = options.findIndex((o) => isAdvanced(o.kind));
  assert.ok(at >= 0);
  rerollForgeOption(hero, options, at, createRng(4));
  rerollForgeOption(hero, options, (at + 1) % 3, createRng(5));
  assert.equal(options.filter((o) => isAdvanced(o.kind)).length, 1);
  assert.ok(isAdvanced(options[at].kind));
});

test("连击：换武器且紧挨上一击才连上；连用同一件或离得远都从头起手；护甲不算落空", () => {
  const monster = { def: MONSTERS.knight, matrix: parseMatrix(["####A", "#####", "#####", "#####"]) };
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger", "slash"], potions: 0 },
    monster,
    rng: createRng(3),
  });
  heroAttack(combat, "dagger", 0, 0);
  combat.phase = "hero";
  heroAttack(combat, "dagger", 1, 0);
  assert.equal(combat.combo, 1, "连用短剑：紧挨着也没落空，但只能从这一击重新起手");
  combat.phase = "hero";
  heroAttack(combat, "slash", 2, 0);
  assert.equal(combat.combo, 2, "换成斜刃，紧挨上一击");
  combat.phase = "hero";
  const armored = heroAttack(combat, "dagger", 0, 3);
  assert.ok(armored.events[0].hits.some((h) => h.before === 2), "打到了护甲心");
  assert.equal(combat.combo, 1, "离上一击太远：重新起手，但没有因为护甲而清零");
  combat.phase = "hero";
  heroAttack(combat, "slash", 1, 3);
  assert.equal(combat.combo, 2);
});

test("序章的墨渍怪：短剑 → 钩镰 → 短剑三下连成一串，拿到第一点充能", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "hook"], potions: 0 },
    monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues },
    rng: createRng(1),
  });
  heroAttack(combat, "dagger", 0, 0);
  monsterTurn(combat);
  heroAttack(combat, "hook", 1, 1);
  assert.equal(combat.combo, 2, "第二下就能看到「连击」");
  assert.equal(combat.energy, ENERGY_START - 1 + ENERGY_PER_LINK, "钩镰花 1 点，连上得回");
  monsterTurn(combat);
  heroAttack(combat, "dagger", 2, 2);
  assert.equal(combat.combo, 3, "连击 ×2");
  assert.equal(combat.energy, Math.min(ENERGY_MAX, ENERGY_START - 1 + 2 * ENERGY_PER_LINK), "再连上一次再得");
  assert.equal(combat.phase, "won", "三下拼完");
});

test("破甲强化：普通武器也能一击击碎护甲心", () => {
  const monster = { def: MONSTERS.rook, matrix: parseMatrix(["AA"]) };
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["hook"], potions: 0, upgrades: { hook: { pierce: true } } },
    monster,
    rng: createRng(1),
  });
  const result = heroAttack(combat, "hook", 0, 0);
  assert.ok(result.events[0].hits.every((h) => h.after === 0));
  assert.equal(combat.phase, "won");
  assert.ok(upgradeOptions({ weapons: ["hook", "awl"], upgrades: {} }, createRng(2), 99).some((o) => o.kind === "pierce" && o.weapon === "hook"));
  assert.ok(!upgradeOptions({ weapons: ["hook"], upgrades: {} }, createRng(2), 99, { pierce: false }).some((o) => o.kind === "pierce"), "护甲怪出场前不刷破甲");
  assert.ok(!upgradeOptions({ weapons: ["dagger", "slash"], upgrades: {} }, createRng(2), 99).some((o) => o.kind === "pierce" || o.kind === "extend"), "轻武器不能破甲、不能延长");
  assert.deepEqual(sanitizeUpgrades({ dagger: { pierce: true, rotate: true }, slash: { extend: true } }), { dagger: { rotate: true } }, "旧存档里不再允许的强化会被去掉");
  assert.ok(!upgradeOptions({ weapons: ["awl"], upgrades: {} }, createRng(2), 99).some((o) => o.kind === "pierce"), "破甲锥本来就破甲");
  assert.ok(!upgradeOptions({ weapons: ["hammer"], upgrades: {} }, createRng(2), 99, { stagger: false }).some((o) => o.kind === "stagger"), "蓄力怪出场前不刷震慑");
  assert.deepEqual(sanitizeUpgrades({ hammer: { steady: true }, hook: { steady: true } }), {}, "稳击已经取消");
});

test("打断重击：怪物蓄力后，重武器一下打碎 3 颗心就能打断；震慑降到 2 颗", () => {
  const step = MONSTERS.knight.pattern.findIndex((p) => p.kind === "charge") + 1;
  const make = (upgrades = {}) => {
    const c = createCombat({
      hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "hammer"], potions: 0, upgrades },
      monster: { def: MONSTERS.knight, matrix: parseMatrix(["####", "####", "####"]), step },
      rng: createRng(1),
    });
    c.energy = ENERGY_MAX;
    return c;
  };
  const combat = make();
  assert.equal(combat.intent.name, "践踏");
  assert.equal(heroAttack(combat, "dagger", 0, 0).events.some((e) => e.type === "interrupt"), false, "短剑打不断");
  combat.phase = "hero";
  combat.combo = 0;
  assert.ok(heroAttack(combat, "hammer", 0, 1).events.some((e) => e.type === "interrupt"), "战锤一下打碎一大片");
  const before = countHearts(combat.heroMatrix).hearts;
  const turn = monsterTurn(combat);
  assert.ok(turn.events.some((e) => e.type === "interrupted"));
  assert.equal(countHearts(combat.heroMatrix).hearts, before, "践踏被打断，没有伤害");

  const weak = make();
  weak.monsterMatrix = parseMatrix(["##..", "....", "...."]);
  assert.equal(heroAttack(weak, "hammer", 0, 0).events.some((e) => e.type === "interrupt"), false, "只打碎 2 颗");
  const staggered = make({ hammer: { stagger: true } });
  staggered.monsterMatrix = parseMatrix(["##..", "....", "...."]);
  assert.ok(heroAttack(staggered, "hammer", 0, 0).events.some((e) => e.type === "interrupt"), "震慑：2 颗就够");
});
test("碎甲技能一下敲碎护甲心；连击不再附带破甲", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0 },
    monster: { def: MONSTERS.rook, matrix: parseMatrix(["####", "####", "##AA"]) },
    rng: createRng(1),
  });
  heroAttack(combat, "dagger", 0, 0);
  combat.phase = "hero";
  heroAttack(combat, "slash", 1, 0);
  combat.phase = "hero";
  heroAttack(combat, "dagger", 1, 2);
  combat.phase = "hero";
  const res = heroAttack(combat, "slash", 1, 2);
  assert.ok(res.events[0].hits.some((h) => h.before === 2 && h.after === 1), "连击中的斜刃只敲掉一层护甲");
  const fresh = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger"], potions: 0, skills: { crush: 2 } },
    monster: { def: MONSTERS.rook, matrix: parseMatrix(["AA"]) },
    rng: createRng(1),
  });
  heroAttack(fresh, "crush", 0, 0);
  assert.equal(fresh.phase, "won", "碎甲一下敲碎两颗护甲心");
});
test("怪物回血：补回的格子连成一片、挨着现有的心；伤口旁的心先被打碎，回血就落空", () => {
  const healStep = MONSTERS.bishop.pattern.findIndex((p) => p.kind === "heal");
  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash"], potions: 0 },
    monster: { def: MONSTERS.bishop, matrix: withHoles(filledMatrix(3, 4), [[1, 1], [1, 2]]), step: healStep },
    rng: createRng(2),
  });
  assert.equal(combat.intent.kind, "heal");
  const plan = combat.healPlan;
  assert.ok(plan.length > 0);
  const keys = new Set(plan.map(([r, c]) => `${r},${c}`));
  assert.ok(plan.every(([r, c]) => combat.monsterMatrix[r][c] === 0), "补的都是空格");
  const linked = plan.every(([r, c]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => keys.has(`${r + dr},${c + dc}`) || combat.monsterMatrix[r + dr]?.[c + dc] > 0));
  assert.ok(linked, "连成一片并挨着心");
  heroWait(combat);
  monsterTurn(combat);
  assert.equal(countHearts(combat.monsterMatrix).hearts, 10 + Math.min(2, MONSTERS.bishop.pattern[healStep].amount));

  const island = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "slash", "hook"], potions: 0 },
    monster: { def: MONSTERS.bishop, matrix: withHoles(filledMatrix(3, 3), [[1, 1]]), step: healStep },
    rng: createRng(2),
  });
  assert.deepEqual(island.healPlan, [[1, 1]]);
  island.monsterMatrix = withHoles(filledMatrix(3, 3), [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]]);
  heroWait(island);
  monsterTurn(island);
  assert.equal(island.monsterMatrix[1][1], 0, "伤口四周的心都碎了，回血落空");
});
test("精准强化：轻武器垫刀接上连击时多得一点充能；中型武器拿不到", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["dagger", "hook"], potions: 0, upgrades: { dagger: { precise: true } } },
    monster: { def: MONSTERS.knight, matrix: parseMatrix(["####", "####"]) },
    rng: createRng(3),
  });
  heroAttack(combat, "hook", 0, 0);
  combat.phase = "hero";
  heroAttack(combat, "dagger", 0, 2);
  assert.equal(combat.combo, 2);
  assert.equal(combat.energy, ENERGY_START - 1 + ENERGY_PER_LINK + 1, "开局的充能 − 钩镰 1 + 连击 + 精准 1");
  assert.deepEqual(sanitizeUpgrades({ dagger: { precise: true }, hook: { precise: true } }), { dagger: { precise: true } });
});
test("铁砧：三项强化固定不变，每项只能刷新一次", () => {
  const hero = { weapons: ["dagger", "hook", "spear"], upgrades: {} };
  const options = createForgeOptions(hero, createRng(4));
  assert.equal(options.length, 3);
  const before = JSON.stringify(options[0]);
  assert.equal(rerollForgeOption(hero, options, 0, createRng(5)).ok, true);
  assert.notEqual(JSON.stringify(options[0]), before);
  assert.equal(rerollForgeOption(hero, options, 0, createRng(6)).ok, false, "同一项不能刷新第二次");
  const keys = options.map((o) => `${o.weapon}:${o.kind}`);
  assert.equal(new Set(keys).size, 3, "刷新后三项仍互不相同");
});

test("武器槽与技能槽：装备数量不超过槽位，技能最多携带三个", () => {
  const board = createBoard(level("pawn-line"), { weapons: weaponsForLevel(at("pawn-line"), STARTING_WEAPONS), skills: skillsForLevel(at("checkmate"), SKILLS) });
  assert.equal(board.hero.slots, 2);
  assert.equal(board.hero.equipped.length, 2);
  assert.ok(board.hero.weapons.length > board.hero.slots, "武器种类多于武器槽");
  assert.equal(toggleEquip(board.hero, "slash").ok, false, "槽位已满");
  toggleEquip(board.hero, board.hero.equipped[0]);
  assert.equal(toggleEquip(board.hero, "slash").ok, true);
  assert.equal(board.hero.equippedSkills.length, SKILL_SLOTS);
  const extra = Object.keys(board.hero.skills).find((id) => !board.hero.equippedSkills.includes(id));
  assert.equal(toggleSkill(board.hero, extra).ok, false, "技能槽已满");
  for (const [index, level] of LEVELS.entries())
    if (index > 1) assert.ok(weaponsForLevel(index, STARTING_WEAPONS).length > level.slots, `${level.name} 武器种类应多于槽位`);
  const combat = createCombat({ hero: board.hero, monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues } });
  assert.equal(combat.weapons.filter((w) => w.kind === "weapon").length, 2, "战斗只带装备中的武器");
  assert.equal(combat.weapons.filter((w) => w.kind === "skill").length, SKILL_SLOTS);
});

test("构筑沿用存档：武器槽变多不会从背包自动补上，新技能不会顶掉已带的技能", () => {
  const weapons = weaponsForLevel(at("bishop-hall"), STARTING_WEAPONS);
  const board = createBoard(level("bishop-hall"), { weapons, equipped: ["dagger", "hook"], skills: skillsForLevel(at("bishop-hall"), SKILLS) });
  assert.equal(board.hero.slots, 3);
  assert.deepEqual(board.hero.equipped, ["dagger", "hook"], "空出来的第三个槽留给玩家自己决定");
  const fresh = createBoard(level("bishop-hall"), { weapons });
  assert.equal(fresh.hero.equipped.length, 3, "没有存档时按获得顺序装满");

  const known = ["swift", "stun", "crush", "meteor"];
  const full = createBoard(level("queen-gallery"), {
    weapons: weaponsForLevel(at("queen-gallery"), STARTING_WEAPONS),
    skills: skillsForLevel(at("queen-gallery"), SKILLS),
    equippedSkills: ["swift", "stun", "meteor"],
    knownSkills: known,
  });
  assert.deepEqual(full.hero.equippedSkills, ["swift", "stun", "meteor"], "技能槽已满：新学会的汲血进背包");
  assert.ok("drain" in full.hero.skills);
  const roomy = createBoard(level("queen-gallery"), {
    weapons: weaponsForLevel(at("queen-gallery"), STARTING_WEAPONS),
    skills: skillsForLevel(at("queen-gallery"), SKILLS),
    equippedSkills: ["swift"],
    knownSkills: known,
  });
  assert.deepEqual(roomy.hero.equippedSkills, ["swift", "drain"], "有空槽才放进新技能，卸下的旧技能不会被自动装回");
});

test("重玩旧章节：保留已解锁的武器槽，拿过的宝箱不再出现，用过的铁砧不能再用", () => {
  const weapons = weaponsForLevel(at("checkmate"), STARTING_WEAPONS);
  const hall = level("bishop-hall");
  const forgeKey = hall.map.flatMap((line, r) => [...line.replace(/\s+/g, "")].map((ch, c) => (ch === "U" ? `${r},${c}` : null))).find(Boolean);
  const board = createBoard(hall, { weapons, equipped: weapons.slice(0, 5), minSlots: 5, usedForges: [forgeKey] });
  assert.equal(board.hero.slots, 5);
  assert.equal(board.hero.equipped.length, 5);
  const items = [...board.items.values()];
  assert.equal(items.find((i) => i.type === "chest"), undefined, "月镰已经拿过，宝箱不再出现");
  assert.ok(items.find((i) => i.type === "forge").opened);
});

test("等待：武器全部冷却、没有药水时也能结束回合，不会卡死", () => {
  const combat = createCombat({
    hero: { matrix: filledMatrix(4, 4), weapons: ["hook"], potions: 0 },
    monster: { def: MONSTERS.pawn, matrix: MONSTERS.pawn.matrixValues },
    rng: createRng(1),
  });
  heroAttack(combat, "hook", 1, 1);
  monsterTurn(combat);
  assert.ok(slotBlocked(combat, combat.weapons[0]), "钩镰在冷却");
  assert.equal(heroWait(combat).ok, true);
  assert.equal(combat.phase, "monster");
});

test("怪物心阵按章节分档成长：前期够连上几下，后期越来越厚", () => {
  const hearts = (id, rank) => countHearts(heartsAt(MONSTERS[id], rank)).hearts;
  assert.equal(hearts("ink", 0), 7, "序章的墨渍怪三下能拼完");
  assert.ok(hearts("pawn", 0) < hearts("pawn", 1) && hearts("pawn", 1) < hearts("pawn", 2));
  assert.ok(hearts("knight", 1) - hearts("knight", 0) < hearts("knight", 2) - hearts("knight", 1) + 2, "越往后涨得越多");
  assert.equal(heartsAt(MONSTERS.bishop, 0), heartsAt(MONSTERS.bishop, 1), "没写的档位沿用最近的一档");
  const late = createBoard(LEVELS[9], { weapons: STARTING_WEAPONS });
  const rook = late.monsters.find((m) => m.def.id === "rook");
  const key = (m) => JSON.stringify(m);
  assert.ok(variantsAt(MONSTERS.rook, 2).map(key).includes(key(rook.matrix)), "棋盘按本章的档位、从这一档的变体里取一套");
});

test("心阵变体：普通怪物每一档至少 3 套，左右对称或中心对称，同一档大小相近；遭遇时随机取一套", () => {
  for (const def of Object.values(MONSTERS)) {
    // 墨渍怪是序章的教学怪物，暗王是首领：特殊怪物只有一套、可以不对称。
    if (def.id === "ink" || def.boss) continue;
    for (const rank of Object.keys(def.ranks)) {
      const list = variantsAt(def, Number(rank));
      assert.ok(list.length >= 3, `${def.name} 第 ${rank} 档只有 ${list.length} 套`);
      list.forEach((m, v) => assert.ok(isMirrorSymmetric(m) || isPointSymmetric(m), `${def.name} 第 ${rank} 档第 ${v + 1} 套既不左右对称也不中心对称`));
      const hearts = list.map((m) => countHearts(m).hearts);
      assert.ok(Math.max(...hearts) - Math.min(...hearts) <= 3, `${def.name} 第 ${rank} 档各套红心数相差太大：${hearts}`);
    }
  }
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const board = createBoard(LEVELS[4], { weapons: STARTING_WEAPONS, rng: createRng(i + 1) });
    seen.add(JSON.stringify(board.monsters.find((m) => m.def.id === "bishop").matrix));
  }
  assert.ok(seen.size >= 3, "多次进入同一章，主教的心阵会换着来");
});

test("心阵的主体由上下左右相邻的心连成：不断开、没有孤立的心、细枝不超过三分之一", () => {
  // “每一击都要挨着上一击”只认上下左右相邻，所以心阵本身也得是上下左右连成的一整片，斜向只做轮廓的边。
  for (const def of Object.values(MONSTERS)) {
    for (const rank of Object.keys(def.ranks)) {
      variantsAt(def, Number(rank)).forEach((m, v) => {
        const problem = shapeProblem(m);
        assert.equal(problem, null, `${def.name} 第 ${rank} 档第 ${v + 1} 套：${problem}`);
      });
    }
  }
});

test("名字长度按显示宽度计：中文最多 9 个字，英文最多 18 个字母", () => {
  assert.equal(nameWidth("屿屿"), 4);
  assert.equal(nameWidth("Yuyu"), 4);
  assert.equal(NAME_MAX_WIDTH, 18);

  // 中文：9 个字刚好，10 个字超限
  assert.equal(validateName("一二三四五六七八九").ok, true);
  assert.equal(validateName("一二三四五六七八九十").ok, false);
  // 英文：18 个字母刚好，19 个超限
  assert.equal(validateName("a".repeat(18)).ok, true);
  assert.equal(validateName("a".repeat(19)).ok, false);
  // 中英混写按宽度折算：4 个汉字（8）+ 10 个字母（10）= 18 刚好，再多一个字母就超限
  assert.equal(validateName("四个汉字" + "a".repeat(10)).ok, true);
  assert.equal(validateName("四个汉字" + "a".repeat(11)).ok, false);
});

test("名字校验：去掉首尾空格、拒绝空名与危险字符", () => {
  assert.deepEqual(validateName("  小 明  ").name, "小 明");
  assert.equal(validateName("").ok, false);
  assert.equal(validateName("   ").ok, false);
  assert.equal(validateName(undefined).ok, false);
  // 名字会被拼进页面，HTML 特殊字符一律拒绝
  for (const bad of ["<b>", "a&b", 'a"b', "a'b", "<script>", "a/b", "😀"]) {
    assert.equal(validateName(bad).ok, false, `${bad} 应被拒绝`);
  }
  // 其他语言的文字、数字和常见符号可以
  for (const good of ["Yuyu", "Léa", "Никита", "さくら", "Tom_2", "A.B-C", "小明·大王"]) {
    assert.equal(validateName(good).ok, true, `${good} 应被接受`);
  }
});

test("主角名会出现在战斗日志与技能、章节文案里；不合格的名字退回默认名", () => {
  try {
    assert.equal(getHeroName(), DEFAULT_HERO_NAME);
    assert.equal(setHeroName("阿福"), "阿福");
    assert.equal(getHeroName(), "阿福");

    const board = createBoard(LEVELS[0], { weapons: STARTING_WEAPONS });
    const combat = createCombat({ hero: board.hero, monster: board.monsters[0], heroFirst: true, rng: createRng(1) });
    assert.ok(combat.log.some((line) => line.includes("阿福")), "战斗日志应使用玩家的名字");
    assert.ok(!combat.log.some((line) => line.includes(DEFAULT_HERO_NAME)), "不应再出现默认名");

    assert.ok(SKILLS.drain.desc.includes("阿福"));
    assert.ok(LEVELS[0].story.includes("阿福"));
    assert.ok(LEVELS[1].story.includes("阿福"));

    assert.equal(setHeroName("<b>"), DEFAULT_HERO_NAME);
    assert.equal(setHeroName(""), DEFAULT_HERO_NAME);
  } finally {
    setHeroName("");
  }
});

/**
 * 前期、中期（rank 0、1）的怪物要求能用一条不断的连击整片拼完；
 * 后期（rank 2）心阵大、招式多，整片搜索太慢也太吃内存，只要求能连出一次追击；
 * 手里只有两件武器的早期章节同样只要求连出第一次追击（标准见 helpers/matrixShape.js 的 matrixGoal）。
 */
test("怪物心阵是给武器拼的：首次登场时，用当时的武器能一条连击拼完（后期至少能打出追击），且比短剑硬磨快", () => {
  const checked = new Set();
  LEVELS.forEach((level, index) => {
    const owned = weaponsForLevel(index, STARTING_WEAPONS);
    for (const spec of level.monsters) {
      const def = MONSTERS[spec.type];
      // 同一档的每一套变体都要检查：遭遇时随机取一套，哪一套都得拼得出来。
      variantsAt(def, level.rank).forEach((matrix, v) => {
        const id = `${def.id}:${JSON.stringify(matrix)}`;
        // 序章只有短剑、还没学连击：这一档留到有两件武器的章节再验证。
        if (checked.has(id) || owned.length < 2) return;
        checked.add(id);
        const goal = matrixGoal(level.rank, owned);
        const best = solveChain({ def, matrix, weapons: owned, slots: level.slots, maxTurns: goal.maxTurns, until: goal.until });
        assert.ok(best, `${level.name}的${def.name}（第 ${v + 1} 套）找不到连击路线`);
        if (goal.beatGrind) {
          const grind = grindTurns({ def, matrix, weapon: "dagger" });
          assert.ok(best.turns < grind, `${level.name}的${def.name}（第 ${v + 1} 套）：连击 ${best.turns} 回合，短剑硬磨 ${grind} 回合`);
        }
      });
    }
  });
});

test("护甲片：走上去拾取；给田字范围内的红心加护甲，空位不受影响；护甲心要挨两下", () => {
  const board = createBoard(LEVELS[2], { weapons: weaponsForLevel(2, STARTING_WEAPONS) });
  const plate = [...board.items.values()].find((i) => i.type === "plate");
  assert.ok(plate, "第 2 章有护甲片");
  board.items.delete(key(plate.r, plate.c));
  board.hero.plates = 1;
  board.hero.matrix[0][1] = 0;
  assert.deepEqual(hitSet(previewPlate(board, 0, 0)), ["0,0", "1,0", "1,1"], "空掉的格子不会长出护甲");
  assert.equal(armorHero(board, -5, -5).ok, false, "完全落在界外");
  assert.equal(armorHero(board, 0, 0).ok, true);
  assert.equal(board.hero.plates, 0);
  assert.equal(countHearts(board.hero.matrix).armor, 3);
  assert.equal(armorHero(board, 2, 2).ok, false, "护甲片用完了");
  const hits = resolveHits(board.hero.matrix, WEAPONS.dagger.shape, 1, 0);
  assert.deepEqual(hits.map((h) => h.after), [1, 1], "先掉护甲，红心还在");
});

test("机制按章节解锁：序章只有短剑和攻击；钩镰是序章奖励；没解锁的动作用不了、也不计连击", () => {
  assert.deepEqual([...featuresAt(0)], [], "序章什么都没解锁");
  assert.deepEqual([...featuresAt(1)].sort(), ["combo", "energy", "potion"]);
  assert.ok(featuresAt(2).has("shield") && featuresAt(2).has("wait") && !featuresAt(2).has("retreat"));
  assert.ok(featuresAt(3).has("retreat"));
  assert.deepEqual(STARTING_WEAPONS, ["dagger"]);
  assert.deepEqual(weaponsForLevel(0, STARTING_WEAPONS), ["dagger"]);
  assert.deepEqual(weaponsForLevel(1, STARTING_WEAPONS), ["dagger", "hook"], "通关序章拿到钩镰");
  assert.equal(WEAPONS.hook.name, "钩镰");

  const combat = createCombat({
    hero: { matrix: filledMatrix(5, 5), weapons: ["dagger", "hook"], potions: 1 },
    monster: { def: MONSTERS.ink, matrix: MONSTERS.ink.matrixValues },
    rng: createRng(1),
    features: featuresAt(0),
  });
  assert.equal(heroShield(combat).ok, false);
  assert.equal(heroWait(combat).ok, false);
  assert.equal(heroRetreat(combat).ok, false);
  assert.equal(heroHeal(combat, 2, 2).ok, false);
  heroAttack(combat, "dagger", 0, 0);
  monsterTurn(combat);
  heroAttack(combat, "hook", 1, 1);
  assert.equal(combat.combo, 0, "没学连击时不计连击");
  assert.equal(combat.energy, ENERGY_START - 1, "也不会因为连击得充能");
});

test("拖动换装：出战内调整顺序、闲置拖上去（有空槽插入，槽满放到某件上互换）、拖下来换下，武器至少留一件", () => {
  const hero = { weapons: ["dagger", "hook", "slash", "spear"], equipped: ["dagger", "hook"], slots: 3, skills: { swift: 2, stun: 1 }, equippedSkills: ["swift"] };
  assert.deepEqual(moveLoadout(hero, { kind: "weapon", id: "hook", toZone: "on", targetId: "dagger", before: true }), { ok: true, changed: true });
  assert.deepEqual(hero.equipped, ["hook", "dagger"], "出战段内调整顺序");
  moveLoadout(hero, { kind: "weapon", id: "slash", toZone: "on", targetId: "hook", before: false });
  assert.deepEqual(hero.equipped, ["hook", "slash", "dagger"], "有空槽：插到放下的位置");
  assert.equal(moveLoadout(hero, { kind: "weapon", id: "spear", toZone: "on", targetId: null }).ok, false, "槽满又没放到某一件上");
  moveLoadout(hero, { kind: "weapon", id: "spear", toZone: "on", targetId: "slash", before: true });
  assert.deepEqual(hero.equipped, ["hook", "spear", "dagger"], "槽满：放到斜刃上就和它互换");
  moveLoadout(hero, { kind: "weapon", id: "dagger", toZone: "off", targetId: "slash" });
  assert.deepEqual(hero.equipped, ["hook", "spear", "slash"], "出战拖到闲置的某一件上：互换");
  moveLoadout(hero, { kind: "weapon", id: "spear", toZone: "off", targetId: null });
  moveLoadout(hero, { kind: "weapon", id: "slash", toZone: "off", targetId: null });
  assert.deepEqual(hero.equipped, ["hook"]);
  assert.equal(moveLoadout(hero, { kind: "weapon", id: "hook", toZone: "off", targetId: null }).ok, false, "至少留一件");
  assert.equal(moveLoadout(hero, { kind: "weapon", id: "cross", toZone: "on" }).ok, false, "没拿到的武器");
  moveLoadout(hero, { kind: "skill", id: "stun", toZone: "on", targetId: null });
  assert.deepEqual(hero.equippedSkills, ["swift", "stun"]);
  moveLoadout(hero, { kind: "skill", id: "swift", toZone: "off", targetId: null });
  assert.deepEqual(hero.equippedSkills, ["stun"], "技能可以全部换下");
});

test("暗王二阶段：心阵第一次清空时不倒下，换成另一种形状的心阵补满，招式换一套（恢复更多、带死灭）；再清空才算胜利", () => {
  const king = MONSTERS.king;
  assert.ok(king.rebirth, "暗王有二阶段");
  assert.equal(shapeProblem(king.rebirth.matrixValues), null, "二阶段心阵也要连成一片");
  assert.ok(isMirrorSymmetric(king.rebirth.matrixValues), "二阶段心阵左右对称");
  assert.notDeepEqual(king.rebirth.matrixValues, heartsAt(king, 2), "二阶段换一种形状");
  assert.ok(king.rebirth.pattern.some((p) => p.kind === "heal"), "二阶段会回血");
  assert.ok(king.rebirth.pattern.some((p) => p.drain), "二阶段有吸取攻击");
  assert.ok(king.rebirth.pattern.some((p) => p.doom), "二阶段有死灭攻击");

  // 只剩一颗心的暗王：短剑打掉它，进入二阶段。
  const combat = createCombat({
    hero: { matrix: filledMatrix(7, 7), weapons: ["dagger", "hammer"], potions: 0 },
    monster: { def: king, matrix: parseMatrix(["#"]) },
    rng: createRng(5),
  });
  combat.weapons[1].cd = 3;
  const result = heroAttack(combat, "dagger", 0, 0);
  assert.ok(result.events.some((e) => e.type === "rebirth"), "触发二阶段");
  assert.ok(!result.events.some((e) => e.type === "won"), "这一下不算胜利");
  assert.equal(combat.phase, "monster", "二阶段由暗王先出手");
  assert.deepEqual(combat.monsterMatrix, king.rebirth.matrixValues, "换成二阶段的满血心阵");
  assert.equal(combat.weapons[1].cd, 0, "武器冷却清空");
  assert.equal(combat.intent, king.rebirth.pattern[0], "招式从新的一套第一招开始");

  // 暗王先出手，然后二阶段再清空：胜利。
  monsterTurn(combat);
  assert.equal(combat.phase, "hero");
  combat.monsterMatrix = parseMatrix(["#"]);
  const final = heroAttack(combat, "dagger", 0, 0);
  assert.ok(final.events.some((e) => e.type === "won"));
  assert.equal(combat.phase, "won");
});


test("怪物的死灭攻击：打空的格子本场战斗里药水和汲血都补不回来；吸取攻击打中几颗心就给怪物补几颗", () => {
  const doomAttack = { kind: "attack", name: "墨潮", shape: parseShape(["##"]), doom: true };
  const drainAttack = { kind: "attack", name: "噬心", shape: parseShape(["#"]), drain: true };
  const def = { ...MONSTERS.pawn, aim: 1, pattern: [doomAttack, drainAttack] };
  const combat = createCombat({
    hero: { matrix: parseMatrix(["###", "###", "###"]), weapons: ["dagger"], potions: 2 },
    monster: { def, matrix: withHoles(parseMatrix(["####", "####"]), [[1, 1]]) },
    heroFirst: false,
    rng: createRng(3),
  });
  const aim = combat.aim;
  monsterTurn(combat);
  assert.equal(combat.heroDoomed.length, 2, "两格被死灭");
  const [[r, c]] = combat.heroDoomed;
  assert.ok(previewHeal(combat, r, c).every((h) => !(h.r === r && h.c === c)), "药水补不到死灭格");
  assert.ok(aim);
  // 第二招吸取：怪物心阵上有空格，打中 1 颗心就补回 1 颗。
  heroWait(combat);
  const before = countHearts(combat.monsterMatrix).hearts;
  const result = monsterTurn(combat);
  assert.ok(result.events.some((e) => e.type === "heal" && e.side === "monster"), "吸取回血");
  assert.equal(countHearts(combat.monsterMatrix).hearts, before + 1);
});

test("王座厅：殿门只有一个缺口，守门的城堡站在缺口里，殿内的城堡站在长毯上；不打倒它们就走不到暗王身边", () => {
  const board = createBoard(level("checkmate"), { weapons: STARTING_WEAPONS });
  const king = board.monsters.find((m) => m.def.id === "king");
  const gate = board.monsters.find((m) => m.def.id === "rook" && m.ai === "static");
  const reachable = (blocked) => {
    const seen = new Set([`${board.hero.r},${board.hero.c}`]);
    const queue = [[board.hero.r, board.hero.c]];
    while (queue.length) {
      const [r, c] = queue.shift();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${r + dr},${c + dc}`;
        if (seen.has(k) || blocked.has(k) || !heroCanEnter(board, r + dr, c + dc).ok) continue;
        seen.add(k);
        queue.push([r + dr, c + dc]);
      }
    }
    return seen;
  };
  const besideKing = (seen) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => seen.has(`${king.r + dr},${king.c + dc}`));
  const hall = board.monsters.find((m) => m.def.id === "rook" && m.ai === "chase");
  const monsters = new Set(board.monsters.map((m) => `${m.r},${m.c}`));
  assert.equal(besideKing(reachable(monsters)), false, "守门的城堡挡住了唯一的缺口");
  monsters.delete(`${gate.r},${gate.c}`);
  assert.equal(besideKing(reachable(monsters)), false, "殿内的城堡挡在长毯上");
  monsters.delete(`${hall.r},${hall.c}`);
  assert.equal(besideKing(reachable(monsters)), true, "两座都打倒，路就通了");
  assert.ok(!board.level.fog, "王座厅没有迷雾");
});

test("王座厅：踏进内门缺口的那一步，门后的城堡一定会扑上来", () => {
  const board = createBoard(level("checkmate"), { weapons: STARTING_WEAPONS });
  const gate = board.monsters.find((m) => m.def.id === "rook" && m.ai === "static");
  const hall = board.monsters.find((m) => m.def.id === "rook" && m.ai === "chase");
  gate.alive = false;
  board.hero.r = hall.r + 2;
  board.hero.c = hall.c;
  assert.equal(advanceMonsters(board).ambush, null, "走到内门前还没被发现");
  const moved = heroMove(board, hall.r + 1, hall.c);
  assert.equal(moved.kind, "moved");
  assert.equal(advanceMonsters(board).ambush, hall, "一踏进缺口就被扑上来");
});

test("王座厅：暗王坐在最后一排正中、守在出口上；打倒它就站上出口，本章完成", () => {
  const board = createBoard(level("checkmate"), { weapons: STARTING_WEAPONS });
  const king = board.monsters.find((m) => m.def.id === "king");
  assert.equal(king.r, 0, "最后一排");
  assert.equal(king.c, (board.level.display.cols - 1) / 2, "显示出来的几列的正中");
  assert.deepEqual([board.exit.r, board.exit.c], [king.r, king.c], "出口在暗王脚下");
  // 不显示的列整列是墙，走不进去。
  for (let r = 0; r < board.rows; r += 1) assert.equal(heroCanEnter(board, r, board.level.display.cols).ok, false);
  board.hero.r = king.r + 1;
  board.hero.c = king.c;
  const won = { phase: "won", heroMatrix: board.hero.matrix, potions: 0, stats: { taken: 0 }, weapons: [], monsterMatrix: [[0]], step: 0 };
  const events = resolveBattle(board, king, won, true);
  assert.ok(events.some((e) => e.type === "exit"), "站上出口");
  assert.equal(board.over, "won");
});

test("王座厅：地图与怪物都以显示出来的几列的中线左右对称", () => {
  const lvl = level("checkmate");
  const cols = lvl.display.cols;
  const mid = (cols - 1) / 2;
  // 出口和起点只有一格，就在中线上；其余格子左右镜像相同。
  const rows = lvl.map.map((line) => [...line.replace(/\s+/g, "")].slice(0, cols).join(""));
  for (const row of rows) assert.equal(row, [...row].reverse().join(""), `「${row}」不对称`);
  for (const m of lvl.monsters) assert.equal(m.at[1], mid, `${m.type} 不在中线上`);
  for (const [, c] of lvl.carpet) assert.equal(c, mid, "长毯铺在中线上");
});

test("暗王倒下又站起时，主角趁机喘息：补回一批红心，死灭格补不回来", () => {
  const king = MONSTERS.king;
  const hero = filledMatrix(7, 7).map((row) => row.map(() => 0));
  hero[0][0] = 1;
  const combat = createCombat({
    hero: { matrix: hero, weapons: ["dagger"], potions: 0 },
    monster: { def: king, matrix: parseMatrix(["#"]) },
    rng: createRng(2),
  });
  combat.heroDoomed = [[0, 1]];
  const result = heroAttack(combat, "dagger", 0, 0);
  const breather = result.events.find((e) => e.type === "heal" && e.breather);
  assert.ok(breather, "转二阶段时主角回血");
  assert.equal(breather.changes.length, king.rebirth.heroHeal);
  assert.ok(!breather.changes.some(({ r, c }) => r === 0 && c === 1), "死灭格补不回来");
});
