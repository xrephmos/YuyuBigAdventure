import "./style.css";
// 战斗界面的统一设计语言（电脑与手机共用），覆盖 style.css 里的旧样式。
import "./battle.css";
// 武器与构筑面板（电脑左侧面板、手机抽屉共用）。
import "./sheet.css";
// 手机竖屏的专用样式，必须在 style.css 之后加载才能覆盖。
import "./phone.css";
import { BoardWorld } from "./render/world.js";
import { Sfx } from "./audio.js";
import { LEVELS, LEGACY_ORDER, weaponsForLevel, skillsForLevel } from "./data/levels.js";
import { WEAPONS, STARTING_WEAPONS, POTION } from "./data/weapons.js";
import { SKILLS } from "./data/skills.js";
import {
  isAdvanced,
  weaponShape,
  applyUpgrade,
  upgradePreview,
  createForgeOptions,
  rerollForgeOption,
  planAdvancedForges,
  hasAdvancedOption,
  toggleEquip,
  toggleSkill,
  swapEquip,
  swapSkill,
  weaponCooldown,
  sanitizeUpgrades,
  UPGRADE_TEXT,
  SKILL_SLOTS,
  moveLoadout,
} from "./logic/arsenal.js";
import { createCoach, skillTopic, TOPICS, TOPICS_PER_MOMENT } from "./ui/coach.js";
import { pinMonster } from "./ui/boardPin.js";
import { rich, kw } from "./ui/keywords.js";
import { getHeroName, setHeroName, validateName } from "./data/heroName.js";
import { isDevMode, devLoadout } from "./logic/devMode.js";
import { recordChapterStart } from "./playLog.js";
import { featuresAt } from "./data/features.js";
import { isTouch } from "./ui/device.js";
import { nameEntryHtml, bindNameEntry } from "./ui/nameEntry.js";

const TOPICS_SLOTS_UP = TOPICS["slots-up"];
import { MONSTERS, INTENT_TEXT } from "./data/monsters.js";
import {
  createBoard,
  heroMove,
  isVisible,
  isExplored,
  visibleMonsterAt,
  NEARBY_PICKUP,
  pickableAt,
  pickupAt,
  useForge,
  heroCanEnter,
  advanceMonsters,
  resolveBattle,
  threatTiles,
  isAdjacent,
  ORTHO,
  key,
  PLATE_SHAPE,
  previewPlate,
  armorHero,
} from "./logic/board.js";
import { createCombat, ENERGY_COST, ENERGY_PER_LINK, CHASE_EVERY } from "./logic/combat.js";
import { countHearts, resolveHeal, applyChanges } from "./logic/shapes.js";
import { runBattle, GLYPH, MOVE_TEXT, traitChips } from "./ui/battleView.js";
import { MatrixView } from "./ui/matrixView.js";
import { SPRITE, icon, shapeSvg, matrixSvg, heartSvg } from "./ui/icons.js";
import { heroSheetHtml, upgradeLegendHtml } from "./ui/heroSheet.js";
import { bindLoadoutDrag } from "./ui/dragLoadout.js";
import { intelBodyHtml } from "./ui/monsterIntel.js";
import { upgradeKeys, upLogo, costMarks, weaponCost } from "./ui/marks.js";

// v3：新增序章；每章开始时的构筑（强化、装备的武器与技能）一起保存；记录看过的新机制说明。
const STORAGE_KEY = "heart-gambit-progress-v3";
const AI_TEXT = { static: "原地驻守", patrol: "往返巡逻", chase: "发现后追击" };

/**
 * 进度按章节的 key 记录（插入新章节不会错位）。
 * profile：跨章节的构筑存档（拥有的武器与技能、强化、出战配置、已解锁的武器槽）。
 * 每通过一章更新一次；重玩旧章节时照样使用它，不会因为回到前面而变弱。
 * forged：{ 章节 key: 用过的铁砧坐标 "r,c" 列表 }，重玩时这些铁砧不能再用。
 * advancedPlan：这一局里第几次使用铁砧会出现进阶强化（见 planAdvancedForges）；第一次打开铁砧时排好。
 */
const PROGRESS_VERSION = 4;
const EMPTY_PROGRESS = { v: PROGRESS_VERSION, unlocked: 1, stars: {}, profile: null, forged: {}, seen: [], hints: true, name: "" };

function loadProgress() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && typeof data.unlocked === "number") return migrate({ ...EMPTY_PROGRESS, v: data.v ?? 3, ...data });
  } catch {
    /* 隐私模式或存储被禁用时退回到本次会话 */
  }
  return { ...EMPTY_PROGRESS };
}

const indexOfKey = (key) => LEVELS.findIndex((l) => l.key === key);

/** 一章里全部铁砧的坐标。 */
const forgeKeys = (level) =>
  level.map.flatMap((line, r) => [...line.replace(/\s+/g, "")].map((ch, c) => (ch === "U" ? `${r},${c}` : null))).filter(Boolean);

/**
 * 旧存档（v3 及更早）按章节序号记录，那时还没有兵阵、镜厅、王城禁卫三章。
 * 把序号换成 key，解锁进度换算到新的章节顺序；按章节分别保存的构筑取走得最远的一份作为 profile。
 */
function migrate(data) {
  if (data.v >= PROGRESS_VERSION) return data;
  const legacyKey = (i) => LEGACY_ORDER[Math.min(i, LEGACY_ORDER.length - 1)];
  const saved = Object.keys(data.loadouts ?? {}).map(Number);
  if (!data.profile && saved.length) {
    const index = indexOfKey(legacyKey(Math.max(...saved)));
    const old = data.loadouts[Math.max(...saved)];
    data.profile = {
      weapons: weaponsForLevel(index, STARTING_WEAPONS),
      skills: Object.keys(skillsForLevel(index, SKILLS)),
      upgrades: old.upgrades ?? {},
      equipped: old.equipped ?? null,
      equippedSkills: old.equippedSkills ?? null,
      slots: LEVELS[index].slots,
    };
  }
  delete data.loadouts;
  data.stars = Object.fromEntries(Object.entries(data.stars ?? {}).map(([id, n]) => [/^\d+$/.test(id) ? legacyKey(+id) : id, n]));
  data.forged = Object.fromEntries(
    Object.entries(data.forged ?? {}).map(([id, used]) => {
      const key = /^\d+$/.test(id) ? legacyKey(+id) : id;
      return [key, Array.isArray(used) ? used : forgeKeys(LEVELS[indexOfKey(key)])];
    }),
  );
  if (data.unlocked > 1) data.unlocked = indexOfKey(legacyKey(data.unlocked - 1)) + 1;
  data.v = PROGRESS_VERSION;
  return data;
}

/** 章节数写成中文：十一个章节。 */
function cnNumber(n) {
  const d = "零一二三四五六七八九";
  if (n < 10) return d[n];
  if (n < 20) return `十${n % 10 ? d[n % 10] : ""}`;
  return `${d[Math.floor(n / 10)]}十${n % 10 ? d[n % 10] : ""}`;
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* 同上 */
  }
}

const app = document.querySelector("#app");
app.innerHTML = `${SPRITE}
  <div class="stage" id="stage" aria-label="3D 棋盘"></div>
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div><strong>心阵棋局</strong><small>HEART GAMBIT</small></div><em class="dev-tag dev-badge" title="开发者模式：全部章节、物品已开放，进度不写入存档">DEV</em></div>
    <div class="chapter" id="chapter"></div>
    <div class="top-actions">
      <span class="turns" id="turns" title="已行动回合"></span>
      <button class="icon-btn" data-cmd="rotate" title="转动视角（C）" aria-label="转动视角">${icon("orbit")}</button>
      <button class="icon-btn" data-cmd="help" title="玩法说明（H）" aria-label="玩法说明">${icon("help")}</button>
      <button class="icon-btn" data-cmd="music" title="音乐开关" aria-label="音乐开关" id="music-btn">${icon("music")}</button>
      <button class="icon-btn" data-cmd="sound" title="音效开关" aria-label="音效开关" id="sound-btn">${icon("sound")}</button>
      <button class="icon-btn" data-cmd="restart" title="重新开始本章（R）" aria-label="重新开始本章">${icon("restart")}</button>
      <button class="icon-btn" data-cmd="levels" title="选择章节" aria-label="选择章节">${icon("menu")}</button>
      <button class="icon-btn phone-menu" data-cmd="menu" aria-label="菜单">${icon("menu")}</button>
    </div>
  </header>
  <aside class="hud hero-hud" id="hero-hud"></aside>
  <aside class="hud goal-hud" id="goal-hud"></aside>
  <div class="hud-strip" id="hud-strip"></div>
  <div class="sheet-backdrop" data-cmd="closeSheet"></div>
  <div class="hint-bar" id="hint-bar"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动</span><span>点击格子 自动寻路</span><span>拖拽 旋转 / 滚轮 缩放</span><span>悬停怪物 查看情报</span></div>
  <div class="dpad" id="dpad" aria-label="方向键">
    <button data-dir="up" aria-label="上">↑</button><button data-dir="left" aria-label="左">←</button><button data-dir="down" aria-label="下">↓</button><button data-dir="right" aria-label="右">→</button>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <div class="tooltip" id="tooltip" hidden></div>
  <div id="battle-root"></div>
  <div class="screen" id="screen" hidden></div>
  <div id="coach-root"></div>`;

const $ = (sel) => document.querySelector(sel);
const world = new BoardWorld($("#stage"));
const sfx = new Sfx();
const progress = loadProgress();
// 存档里的名字要重新校验（可能被手动改过）；没有合格的名字就留空，开局时让玩家起名。
progress.name = validateName(progress.name).ok ? validateName(progress.name).name : "";
setHeroName(progress.name);
syncDevMode();
// 音效与音乐开关各自记住。
sfx.enabled = progress.audio?.sfx !== false;
sfx.musicEnabled = progress.audio?.music !== false;

/** 每个场景对应一首背景音乐。 */
const BATTLE_TRACK = { ink: "battle", pawn: "battle", knight: "elite", bishop: "elite", rook: "elite", queen: "elite", king: "boss" };
const boardTrack = () => (board?.level.goal === "boss" ? "throne" : board?.level.fog ? "fog" : "board");
const explain = createCoach({
  root: $("#coach-root"),
  enabled: () => progress.hints !== false,
  seen: (id) => progress.seen.includes(id),
  markSeen: (id) => {
    progress.seen = [...progress.seen, id];
    saveProgress();
  },
  sfx,
});

let board = null;
let levelIndex = 0;
let busy = false;
let playing = false;
let hoverTile = null;
let walkToken = 0;
let levelGen = 0;
let screenName = null;
let screenBack = null;
let currentCombat = null;
let slotsBefore = 0;
/** 本章新学会的技能（存档里还没有它），进入章节时就宣布；没有则为 null。 */
let freshSkill = null;
/** 序章里钉在第一只怪物头顶的“点击发起战斗”标记的移除函数；没有标记时为 null。 */
let engagePin = null;

/** 移除“点击发起战斗”标记（开战、换关、回到标题时都要收掉）。 */
function clearEngagePin() {
  engagePin?.();
  engagePin = null;
}
/** “目标”面板里展开情报的那只怪物（uid，如 "pawn-0"），null 表示都收起。 */
let intelUid = null;

// ——— 通用提示 ———

let toastTimer = 0;
function toast(html, tone = "") {
  const el = $("#toast");
  el.innerHTML = html;
  el.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ——— HUD ———

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 瑞士风小标题：等宽编号 + 中文 + 英文大写。 */
const kicker = (nb, zh, en, extra = "") =>
  `<div class="kicker${extra.includes("build-chip") ? " with-chip" : ""}"><span class="kicker-nb">${nb}</span><span>${zh}</span><span class="kicker-en">${en}</span>${extra}</div>`;

/** 开发者模式的小标签（章节选择标题旁）。 */
const devTag = () => '<em class="dev-tag" title="开发者模式：全部章节、物品已开放，进度不写入存档">DEV</em>';

/** 按当前名字切换开发者模式：页面加上 dev-mode 类，顶栏显示 DEV 标记。 */
function syncDevMode() {
  document.body.classList.toggle("dev-mode", isDevMode());
}

/** 手机抽屉顶部的标题栏：标题 + 大号关闭按钮（桌面上两块面板常驻，不显示）。 */
const sheetHead = (title) =>
  `<header class="sheet-head"><b>${title}</b><button class="icon-btn" data-cmd="closeSheet" aria-label="收起">${icon("close")}</button></header>`;

function renderHud() {
  if (!board) return;
  const level = board.level;
  $("#chapter").innerHTML = `<span class="t-meta">CH.${pad(level.id)}</span><b>${level.name}</b><em class="t-meta">${level.english}</em>`;
  $("#turns").innerHTML = `<span class="t-meta">TURN</span><b>${pad(board.turn)}</b><span class="t-meta">PAR ${level.par}</span>`;
  const { hearts, slots } = countHearts(board.hero.matrix);
  const hero = board.hero;
  // 手机上：两块大面板收起来，只在棋盘上方留一条信息栏，点按钮才从底部拉出面板。
  const alive = board.monsters.filter((m) => m.alive);
  // 钥匙、护甲片的格子只看本章地图里有没有：整章固定占位（数量为 0 时变淡），
  // 拾取的那一刻不会凭空多出一格、把旁边的东西挤开。
  const carries = levelCarries(level);
  $("#hud-strip").innerHTML = `
    <span class="strip-hp ${hearts / slots < 0.35 ? "low" : ""}">${heartSvg("heart")}<b>${hearts}</b><small>/${slots}</small></span>
    ${unlockedFeatures().has("potion") ? `<button class="strip-chip" data-cmd="potion" ${hero.potions && hearts < slots ? "" : "disabled"} aria-label="喝药水">${icon("potion")}<b>${hero.potions}</b></button>` : ""}
    ${carries.keys || hero.keys ? `<span class="strip-chip ${hero.keys ? "" : "off"}">${icon("key")}<b>${hero.keys}</b></span>` : ""}
    ${carries.plates || hero.plates ? `<button class="strip-chip" data-cmd="armor" ${hero.plates ? "" : "disabled"} aria-label="使用护甲片">${icon("armor")}<b>${hero.plates}</b></button>` : ""}
    <span class="strip-gap"></span>
    <button class="strip-btn" data-cmd="sheetHero">${icon("sword")}武器</button>
    <button class="strip-btn" data-cmd="sheetGoal">${icon("exit")}目标<em>${alive.length}</em></button>`;
  // 面板内容重建时保留滚动位置：手机抽屉里喝完药水、换完武器，列表不会跳回顶部。
  const keepScroll = (el, html) => {
    const top = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = top;
  };
  keepScroll($("#hero-hud"), heroSheetHtml({ hero, features: unlockedFeatures(), kicker, sheetHead, carries }));

  keepScroll(
    $("#goal-hud"),
    `
    ${sheetHead("目标")}
    ${kicker("04", "目标", "OBJECTIVE")}
    <p class="goal">${rich(level.goalText)}</p>
    ${kicker("05", "敌人", "HOSTILES", `<em>${alive.length}/${board.monsters.length}</em>`)}
    <ul class="enemy-list">${board.monsters
      .map((m) => {
        const { hearts: h, slots: sl } = countHearts(m.matrix);
        if (!m.seen) return `<li class="unseen"><span class="avatar-sm unknown">?</span><span class="wn"><b>未发现</b><small>位于迷雾中</small></span><em>?</em></li>`;
        const hp = m.def.boss ? "?" : `${h}/${sl}`;
        // 活着的怪物点一下展开情报（招式循环与心阵），再点一下收起：手机上没有悬停，靠这里查看。
        const open = m.alive && intelUid === m.uid;
        const row = `<li class="${m.alive ? "" : "dead"} ${m.aggro && m.alive ? "alert" : ""} ${open ? "open" : ""}" data-uid="${m.uid}" ${m.alive ? `data-intel="${m.uid}" title="查看情报"` : ""}><span class="avatar-sm ${m.def.model}">${GLYPH[m.def.model]}</span><span class="wn"><b>${m.def.name}${m.alive && !m.def.boss ? `<span class="traits mini">${traitChips(m.def)}</span>` : ""}</b><small>${m.alive ? `${m.def.boss ? "情报不明" : AI_TEXT[m.ai]}${m.stun ? " · 晕眩" : ""}` : "已击败"}</small></span><em>${m.alive ? hp : "0"}</em></li>`;
        return open ? `${row}<li class="enemy-intel">${intelBodyHtml(m, { cell: 11 })}<p class="tip-foot t-meta">${monsterFoot(m)}</p></li>` : row;
      })
      .join("")}</ul>
    <p class="hud-foot"><span class="sq ${board.exitOpen ? "on" : ""}"></span>${board.exitOpen ? "出口已开启" : "出口已被封印"}</p>`,
  );
}

/**
 * 本章地图上有没有钥匙（或铁栅门）、护甲片：决定信息栏和武器面板里要不要给它们留一格。
 * 只看地图字符画，拾取之后也不变，所以整章里这些格子的位置是固定的。
 */
function levelCarries(level) {
  const has = (ch) => level.map.some((row) => row.includes(ch));
  return { keys: has("K") || has("L"), plates: has("A") };
}

/** 槽位小方块：实心为已占用。 */
function slotPips(used, total, tone = "") {
  return `<em class="slot-pips ${tone}" title="${used}/${total}">${Array.from({ length: total }, (_, i) => `<i class="${i < used ? "on" : ""}"></i>`).join("")}</em>`;
}

// ——— 棋盘高亮与情报卡 ———

/**
 * 自动寻路。只走已探索的格子，只绕开玩家看得见的怪物（迷雾里的怪物会被撞上，触发战斗）。
 * 目标是宝箱或药水时，走到它旁边为止。
 */
function findPath(target, { ignoreMonsters = false } = {}) {
  const start = key(board.hero.r, board.hero.c);
  const goal = key(target.r, target.c);
  const goalItem = board.items.get(goal);
  const pickupGoal = Boolean(goalItem && NEARBY_PICKUP.has(goalItem.type) && !goalItem.opened);
  const prev = new Map([[start, null]]);
  const queue = [{ r: board.hero.r, c: board.hero.c }];
  while (queue.length) {
    const cur = queue.shift();
    const k = key(cur.r, cur.c);
    if (k === goal) {
      const path = [];
      let step = k;
      while (step !== start) {
        const [r, c] = step.split(",").map(Number);
        path.unshift({ r, c });
        step = prev.get(step);
      }
      return pickupGoal ? path.slice(0, -1) : path;
    }
    for (const [dr, dc] of ORTHO) {
      const nr = cur.r + dr;
      const nc = cur.c + dc;
      const nk = key(nr, nc);
      if (prev.has(nk) || !isExplored(board, nr, nc)) continue;
      const isGoal = nk === goal;
      const seen = visibleMonsterAt(board, nr, nc);
      if (!(isGoal && (seen || pickupGoal))) {
        if (!heroCanEnter(board, nr, nc).ok) continue;
        if (!ignoreMonsters && seen) continue;
      }
      prev.set(nk, k);
      queue.push({ r: nr, c: nc });
    }
  }
  return null;
}

function refreshMarks() {
  if (!board) return;
  const marks = new Map();
  if (playing && !busy) {
    for (const [dr, dc] of ORTHO) {
      const r = board.hero.r + dr;
      const c = board.hero.c + dc;
      if (visibleMonsterAt(board, r, c)) marks.set(key(r, c), "attack");
      else if (pickableAt(board, r, c) || heroCanEnter(board, r, c).ok) marks.set(key(r, c), "move");
    }
  }
  if (hoverTile) {
    const m = visibleMonsterAt(board, hoverTile.r, hoverTile.c);
    if (m) for (const t of threatTiles(board, m)) if (!marks.has(key(t.r, t.c))) marks.set(key(t.r, t.c), "threat");
    if (playing && !busy && !isAdjacent(board.hero, hoverTile)) {
      const path = findPath(hoverTile);
      if (path) path.forEach((p, i) => marks.set(key(p.r, p.c), i === path.length - 1 && m ? "attack" : "path"));
    }
    if (!marks.has(key(hoverTile.r, hoverTile.c)) && isExplored(board, hoverTile.r, hoverTile.c))
      marks.set(key(hoverTile.r, hoverTile.c), "hover");
  }
  world.setMarks(marks);
}

function showItemTip(item, event) {
  const tip = $("#tooltip");
  const text = {
    // 宝箱里是什么，打开之前不透露。
    chest: ["宝箱", "内容在开启后揭晓。"],
    potion: ["红心药水", POTION.desc],
    forge: ["铁砧", "从三项强化中选择一项。"],
  }[item.type];
  if (!text) return;
  tip.innerHTML = `<div class="tip-head tip-item"><span class="tip-icon">${icon({ chest: "chest", potion: "potion", forge: "anvil" }[item.type])}</span><div><b>${text[0]}</b><small>${text[1]}</small></div></div>`;
  tip.hidden = false;
  const x = Math.min(event.clientX + 18, innerWidth - tip.offsetWidth - 12);
  const y = Math.min(event.clientY + 18, innerHeight - tip.offsetHeight - 12);
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

/** 情报卡底部一行：移动方式 · 巡逻方式 · 视野 · 是否晕眩。 */
const monsterFoot = (monster) =>
  `${MOVE_TEXT[monster.def.moves]} · ${AI_TEXT[monster.ai]}${monster.sight ? ` · 视野 ${monster.sight} 格` : ""}${monster.stun ? " · 晕眩中" : ""}`;

function showTooltip(monster, event) {
  const tip = $("#tooltip");
  if (!monster || !event) {
    tip.hidden = true;
    return;
  }
  const def = monster.def;
  const { hearts, slots } = countHearts(monster.matrix);
  if (def.boss) {
    // Boss 的情报隐藏：只显示名字。
    tip.innerHTML = `<div class="tip-head"><span class="avatar-sm ${def.model}">${GLYPH[def.model]}</span><div><b>${def.name}</b><small>${def.title}</small></div><span class="tip-hp"><span class="num">?</span></span></div><p class="tip-foot t-meta">情报不明</p>`;
    tip.hidden = false;
    const x = Math.min(event.clientX + 18, innerWidth - tip.offsetWidth - 12);
    const y = Math.min(event.clientY + 18, innerHeight - tip.offsetHeight - 12);
    tip.style.transform = `translate(${x}px, ${y}px)`;
    return;
  }
  tip.innerHTML = `
    <div class="tip-head"><span class="avatar-sm ${def.model}">${GLYPH[def.model]}</span><div><b>${def.name}</b><small>${def.title}</small></div><span class="tip-hp"><span class="num">${hearts}</span><span class="of">/${slots}</span></span></div>
    ${traitChips(def) ? `<p class="traits tip-traits">${traitChips(def)}</p>` : ""}
    ${intelBodyHtml(monster)}
    <p class="tip-foot t-meta">${monsterFoot(monster)}</p>`;
  tip.hidden = false;
  const x = Math.min(event.clientX + 18, innerWidth - tip.offsetWidth - 12);
  const y = Math.min(event.clientY + 18, innerHeight - tip.offsetHeight - 12);
  tip.style.transform = `translate(${x}px, ${y}px)`;
}

world.on("hover", (r, c, event) => {
  const same = hoverTile && r === hoverTile.r && c === hoverTile.c;
  hoverTile = r === null ? null : { r, c };
  const m = board && hoverTile ? visibleMonsterAt(board, r, c) : null;
  const found = board && hoverTile && !m && isExplored(board, r, c) ? board.items.get(key(r, c)) : null;
  const item = found && found.type !== "key" && !found.opened ? found : null;
  if (item && !screenName) showItemTip(item, event);
  else showTooltip(screenName ? null : m, event);
  document.body.style.cursor = hoverTile && playing ? "pointer" : "";
  if (!same) refreshMarks();
});

world.on("click", (r, c) => {
  if (!playing || busy || screenName) return;
  sfx.unlock();
  if (isAdjacent(board.hero, { r, c }) && !pickableAt(board, r, c)) {
    walkToken += 1;
    step(r, c);
    return;
  }
  if (!isExplored(board, r, c)) {
    sfx.play("bump");
    toast("迷雾中无法查看");
    return;
  }
  if (pickableAt(board, r, c)) {
    walkToken += 1;
    if (isAdjacent(board.hero, { r, c })) {
      interact(r, c);
      return;
    }
    const route = findPath({ r, c });
    if (!route) {
      sfx.play("bump");
      toast("无法到达");
      return;
    }
    autoWalk(route).then((arrived) => {
      if (arrived && isAdjacent(board.hero, { r, c })) interact(r, c);
    });
    return;
  }
  const path = findPath({ r, c });
  if (path && !path.length) return;
  if (!path) {
    sfx.play("bump");
    toast(findPath({ r, c }, { ignoreMonsters: true }) ? "路线被怪物阻挡" : "无法到达");
    return;
  }
  autoWalk(path);
});

// ——— 回合流程 ———

/** 沿路径逐格行走；中途被事件打断时返回 false。 */
async function autoWalk(path) {
  const token = ++walkToken;
  for (const p of path) {
    if (token !== walkToken || !playing) return false;
    const outcome = await step(p.r, p.c);
    if (outcome !== "moved") return false;
  }
  return token === walkToken;
}

/** 使用相邻的铁砧（不消耗回合）。 */
async function interact(r, c) {
  if (busy || !playing) return;
  const result = pickupAt(board, r, c);
  if (!result.ok) {
    sfx.play("bump");
    toast(result.reason);
    return;
  }
  busy = true;
  showTooltip(null);
  try {
    await world.faceToward(world.hero, world.items.get(key(r, c))?.position ?? world.hero.position);
    for (const event of result.events) {
      if (event.type === "forge") {
        await explain(["forge"]);
        showForge(event.item);
      }
    }
  } finally {
    busy = false;
    renderHud();
    refreshMarks();
  }
}

/** 某类怪物第一次出场的章节。 */
const firstLevelWith = (test) => LEVELS.findIndex((l) => l.monsters.some((m) => test(MONSTERS[m.type])));
/** 第一只护甲怪出场之前，铁砧不会刷出破甲。 */
const FIRST_ARMOR_LEVEL = firstLevelWith((def) => def.armored);
/** 第一只会蓄力重击的怪物出场之前，铁砧不会刷出震慑（没有重击可打断）。 */
const FIRST_CHARGE_LEVEL = firstLevelWith((def) => def.pattern.some((p) => p.kind === "charge"));
/** 第一只会回血的怪物出场之前，铁砧不会刷出死灭（没有回血可阻止）。 */
const FIRST_HEAL_LEVEL = firstLevelWith((def) => def.pattern.some((p) => p.kind === "heal"));
const forgeRules = () => ({ pierce: levelIndex >= FIRST_ARMOR_LEVEL, stagger: levelIndex >= FIRST_CHARGE_LEVEL, heal: levelIndex >= FIRST_HEAL_LEVEL });

/** 整个游戏的铁砧总数：每章地图上 U 的个数相加。 */
const TOTAL_FORGES = LEVELS.reduce((sum, level) => sum + forgeKeys(level).length, 0);
/** 排进阶强化时只算终章之前的铁砧：终章才拿到的进阶强化几乎没有机会用上。 */
const PLANNED_FORGES = TOTAL_FORGES - forgeKeys(LEVELS[LEVELS.length - 1]).length;

/**
 * 这一次使用铁砧是整局里的第几次（从 0 起）：已通过章节里用过的铁砧，加上本章（含这一次尝试）用过的。
 * 只有选了强化才算用过，所以中途退出、重开章节时序号不变。
 */
function forgeUseIndex() {
  const key = LEVELS[levelIndex].key;
  const elsewhere = Object.entries(progress.forged ?? {}).reduce((sum, [k, used]) => sum + (k === key ? 0 : used.length), 0);
  const here = new Set([...(progress.forged?.[key] ?? []), ...(board.forgesUsed ?? [])]);
  return elsewhere + here.size;
}

/** 这一座铁砧有没有排到进阶强化。旧存档第一次用到时补排，已经拿到的进阶强化计入总数。 */
function forgeHasAdvanced() {
  if (!Array.isArray(progress.advancedPlan)) {
    const owned = Object.values(board.hero.upgrades ?? {}).reduce((n, up) => n + Object.keys(up).filter((k) => up[k] && isAdvanced(k)).length, 0);
    progress.advancedPlan = planAdvancedForges({ total: PLANNED_FORGES, used: forgeUseIndex(), owned });
    saveProgress();
  }
  const index = forgeUseIndex();
  if (!progress.advancedPlan.includes(index)) return false;
  // 排到了，但手上的武器已经没有能拿的进阶强化：顺延到下一次使用铁砧，这一局的总数不变。
  if (!hasAdvancedOption(board.hero, forgeRules())) {
    let next = index + 1;
    while (progress.advancedPlan.includes(next)) next += 1;
    progress.advancedPlan = progress.advancedPlan.map((i) => (i === index ? next : i)).filter((i) => i < TOTAL_FORGES).sort((a, b) => a - b);
    saveProgress();
    return false;
  }
  return true;
}

/** 铁砧卡片上的说明：延长、巨化写明多几格，其余用强化本身的说明。 */
function forgeDesc(opt) {
  const w = WEAPONS[opt.weapon];
  if (opt.kind === "extend") return `战斗中可切换为加长形状（多 ${w.plusShape.size - w.shape.size} 格），不占用回合。`;
  if (opt.kind === "giant") return `多一枚巨化按钮：可切换为 ${w.giantShape.size} 格的巨化形状，与延长各自开关，不占用回合。`;
  return rich(UPGRADE_TEXT[opt.kind].desc);
}

/** 铁砧：随机给出三项强化，玩家选一项；也可以暂不强化，稍后再来。 */
function showForge(item) {
  item.options ??= createForgeOptions(board.hero, Math.random, forgeRules(), { advanced: forgeHasAdvanced() });
  if (!item.options.length) {
    toast("所有武器均已强化完毕");
    return;
  }
  playing = false;
  const cardHtml = (opt, i) => {
    const w = WEAPONS[opt.weapon];
    const { before, after } = upgradePreview(opt, board.hero.upgrades);
    const equipped = board.hero.equipped.includes(opt.weapon);
    // 进阶强化的卡片：黑底、蓝色细框、右上角“进阶”标签，一眼看出稀有。
    const adv = isAdvanced(opt.kind);
    return `<button class="forge-card ${adv ? "adv" : ""}" data-upgrade="${i}">
        ${adv ? '<span class="forge-tag">进阶</span>' : ""}
        <span class="t-meta forge-weapon">${w.name}${equipped ? "" : `<i class="in-bag" title="在背包里">${icon("bag")}</i>`}</span>
        <b>${upLogo(opt.kind)}${UPGRADE_TEXT[opt.kind].name}</b>
        <span class="forge-shapes"><span>${shapeSvg(before, { cell: 14, gap: 3 })}</span><i aria-hidden="true">→</i><span>${shapeSvg(after, { cell: 14, gap: 3 })}</span></span>
        <small>${forgeDesc(opt)}</small>
      </button>
      <button class="reroll" data-reroll="${i}" ${opt.rerolled ? "disabled" : ""}>${icon("restart")}${opt.rerolled ? "已重抽" : "重抽"}</button>`;
  };
  showScreen(
    "forge",
    `<div class="panel forge">
      <header class="panel-head"><div>${kicker(icon("anvil"), "铁砧", "FORGE")}<h2>选择一项强化</h2></div><button class="icon-btn" data-cmd="back" aria-label="暂不强化">${icon("close")}</button></header>
      <div class="forge-grid">${item.options.map((opt, i) => `<div class="forge-slot" data-slot="${i}">${cardHtml(opt, i)}</div>`).join("")}</div>
      <div class="panel-actions"><button class="ghost" data-cmd="back">暂不强化</button></div>
    </div>`,
  );
  screenBack = () => {
    hideScreen();
    playing = true;
    refreshMarks();
  };
  const grid = document.querySelector(".forge-grid");
  let spinning = false;

  // 重抽只替换这一张卡：先翻过去，换上新内容，再翻回来。整个窗口不重建，所以不会抽动。
  async function reroll(i) {
    if (spinning) return;
    const result = rerollForgeOption(board.hero, item.options, i, Math.random, forgeRules());
    if (!result.ok) {
      sfx.play("invalid");
      toast(result.reason);
      return;
    }
    spinning = true;
    sfx.play("flip");
    const slot = grid.querySelector(`[data-slot="${i}"]`);
    slot.classList.add("flip-out");
    await sleep(180);
    slot.innerHTML = cardHtml(item.options[i], i);
    slot.classList.remove("flip-out");
    slot.classList.add("flip-in");
    await sleep(320);
    slot.classList.remove("flip-in");
    spinning = false;
  }

  function choose(i) {
    if (spinning) return;
    const opt = item.options[i];
    applyUpgrade(board.hero, opt);
    useForge(board, item.r, item.c);
    board.forgesUsed = [...(board.forgesUsed ?? []), `${item.r},${item.c}`];
    world.useForge(item.r, item.c);
    sfx.play("anvil");
    toast(`${icon(UPGRADE_TEXT[opt.kind].icon)}<b>${WEAPONS[opt.weapon].name}</b> ${UPGRADE_TEXT[opt.kind].name}`, "gold");
    hideScreen();
    playing = true;
    renderHud();
    refreshMarks();
  }

  grid.addEventListener("click", (e) => {
    const rerollBtn = e.target.closest("[data-reroll]");
    if (rerollBtn) return reroll(Number(rerollBtn.dataset.reroll));
    const card = e.target.closest("[data-upgrade]");
    if (card) choose(Number(card.dataset.upgrade));
  });
}

/**
 * 构筑：左边是出战的武器槽与技能槽，右边是背包。点卡片就在两侧之间移动；
 * 槽位满了时，先点背包里的卡片，再点左边要换下的那一张。
 */
/** 强化说明弹窗：主角区“构筑”那一行尾部的问号打开，列出拥有的武器身上的全部强化。 */
function showUpgradeHelp() {
  if (!board || busy || screenName || document.body.classList.contains("in-battle")) return;
  const was = playing;
  playing = false;
  showScreen(
    "upgrades",
    `<div class="panel upgrade-help">
      <header class="panel-head"><div>${kicker(icon("anvil"), "强化", "UPGRADES")}<h2>强化说明</h2></div><button class="icon-btn" data-cmd="back" aria-label="关闭">${icon("close")}</button></header>
      ${upgradeLegendHtml(board.hero)}
    </div>`,
  );
  screenBack = () => {
    hideScreen();
    playing = was;
    refreshMarks();
  };
}

function showArmory() {
  if (!board || busy || screenName || document.body.classList.contains("in-battle") || !document.body.classList.contains("in-level")) return;
  const was = playing;
  playing = false;
  const hero = board.hero;
  let pending = null; // { kind: "weapon" | "skill", id }

  const weaponCard = (id, side) => {
    const w = WEAPONS[id];
    const picked = pending?.kind === "weapon" && pending.id === id;
    return `<button class="build-card ${side} ${picked ? "picked" : ""}" data-kind="weapon" data-id="${id}" title="${w.desc}">
      <span class="build-shape">${shapeSvg(weaponShape(id, hero.upgrades), { cell: 11, gap: 2 })}</span>
      <span class="build-text"><b>${w.name}${upgradeKeys(id, hero.upgrades).map(upLogo).join("")}</b><small>${w.desc}</small></span>
      <span class="build-meta">${costMarks(weaponCost(id))}</span>
      <span class="build-move" aria-hidden="true">${side === "on" ? "→" : pending?.kind === "weapon" && !picked ? "" : "←"}</span>
    </button>`;
  };
  const skillCard = (id, side) => {
    const sk = SKILLS[id];
    const picked = pending?.kind === "skill" && pending.id === id;
    return `<button class="build-card skill ${side} ${picked ? "picked" : ""}" data-kind="skill" data-id="${id}" title="${sk.desc}">
      <span class="build-shape">${shapeSvg(sk.shape, { cell: 11, gap: 2, tone: "skill" })}</span>
      <span class="build-text"><b>${sk.name}</b><small>${sk.desc}</small></span>
      <span class="build-meta">${icon("skill")}×${hero.skills[id]}</span>
      <span class="build-move" aria-hidden="true">${side === "on" ? "→" : "←"}</span>
    </button>`;
  };
  const emptySlot = (kind) => `<div class="build-card empty empty-${kind}">${icon(kind === "skill" ? "skill" : "sword")}</div>`;
  // 背包一侧预留到“最多可能有几件”的行数：换上换下时背包列表长短会变，占位卡让整个面板高度保持不变。
  // 占位卡用一张真实卡片的内容撑出同样的高度（再整张隐藏），高度才能分毫不差。
  const ghosts = (n, card) => card.replace('class="build-card', 'aria-hidden="true" tabindex="-1" class="build-card build-ghost').repeat(Math.max(0, n));

  const draw = () => {
    const bagWeapons = hero.weapons.filter((id) => !hero.equipped.includes(id));
    const ownedSkills = Object.keys(hero.skills);
    const bagSkills = ownedSkills.filter((id) => !hero.equippedSkills.includes(id));
    const weaponSlots = Array.from({ length: hero.slots }, (_, i) => (hero.equipped[i] ? weaponCard(hero.equipped[i], "on") : emptySlot("weapon"))).join("");
    const skillSlots = Array.from({ length: SKILL_SLOTS }, (_, i) => (hero.equippedSkills[i] ? skillCard(hero.equippedSkills[i], "on") : emptySlot("skill"))).join("");
    showScreen(
      "armory",
      `<div class="panel armory ${pending ? `swapping swap-${pending.kind}` : ""}">
        <header class="panel-head"><div>${kicker(icon("bag"), "构筑", "BUILD")}<h2>构筑</h2></div><button class="icon-btn" data-cmd="back" aria-label="完成">${icon("close")}</button></header>
        <div class="loadout">
          <section class="loadout-col">
            <h4 class="build-title">${kw("武器槽")}${slotPips(hero.equipped.length, hero.slots)}</h4>
            <div class="build-list">${weaponSlots}</div>
            ${ownedSkills.length ? `<h4 class="build-title">${kw("技能")}${slotPips(hero.equippedSkills.length, SKILL_SLOTS, "skill")}</h4><div class="build-list">${skillSlots}</div>` : ""}
          </section>
          <div class="loadout-rule" aria-hidden="true"><span>⇄</span></div>
          <section class="loadout-col bag">
            <h4 class="build-title">${kw("闲置", "背包")}<em class="t-meta">${bagWeapons.length + bagSkills.length}</em></h4>
            <div class="build-list">${bagWeapons.map((id) => weaponCard(id, "off")).join("") || '<div class="build-card empty bag"></div>'}${ghosts(hero.weapons.length - 1 - Math.max(1, bagWeapons.length), weaponCard(hero.weapons[0], "off"))}</div>
            ${ownedSkills.length ? `<h4 class="build-title">${kw("技能")}</h4><div class="build-list">${bagSkills.map((id) => skillCard(id, "off")).join("") || '<div class="build-card empty bag"></div>'}${ghosts(ownedSkills.length - Math.max(1, bagSkills.length), skillCard(ownedSkills[0], "off"))}</div>` : ""}
          </section>
        </div>
        <div class="panel-actions"><button class="primary" data-cmd="back">完成<span aria-hidden="true">→</span></button></div>
      </div>`,
      { wide: true },
    );
    screenBack = () => {
      hideScreen();
      playing = was;
      renderHud();
      refreshMarks();
    };
    document.querySelectorAll(".armory [data-kind]:not(.build-ghost)").forEach((btn) => btn.addEventListener("click", () => pick(btn.dataset.kind, btn.dataset.id)));
  };

  const done = (result) => {
    if (!result.ok) {
      sfx.play("invalid");
      toast(result.reason);
    } else sfx.play("click");
    draw();
  };

  function pick(kind, id) {
    const equippedList = kind === "weapon" ? hero.equipped : hero.equippedSkills;
    const cap = kind === "weapon" ? hero.slots : SKILL_SLOTS;
    const onSide = equippedList.includes(id);
    if (pending) {
      const p = pending;
      pending = null;
      // 换下：先选了背包里的卡，再点同类的出战卡。
      if (p.kind === kind && onSide) return done(kind === "weapon" ? swapEquip(hero, id, p.id) : swapSkill(hero, id, p.id));
      if (p.kind === kind && p.id === id) return done({ ok: true });
    }
    if (!onSide && equippedList.length >= cap) {
      pending = { kind, id };
      sfx.play("click");
      return draw();
    }
    done(kind === "weapon" ? toggleEquip(hero, id) : toggleSkill(hero, id));
  }
  draw();
}

/** 主角走一步，然后怪物行动。返回 moved / blocked / battle / event / over。 */
async function step(r, c) {
  if (busy || !playing) return "blocked";
  busy = true;
  hoverTile = null;
  refreshMarks();
  showTooltip(null);
  let outcome = "moved";
  const gen = levelGen;
  try {
    const result = heroMove(board, r, c);
    if (result.kind === "blocked") {
      sfx.play("bump");
      toast(pickableAt(board, r, c) ? "须站在铁砧相邻的格子上点击" : result.reason);
      await world.bump({ dr: r - board.hero.r, dc: c - board.hero.c });
      return "blocked";
    }
    if (result.kind === "battle") {
      await battle(result.monster, true);
      return board.over ? "over" : "battle";
    }
    sfx.play("step");
    await world.moveHero(result.events[0].to);
    if (gen !== levelGen) return "over";
    world.updateFog(board);
    for (const event of result.events.slice(1)) {
      outcome = "event";
      if (event.type === "pickup") await pickup(event.item);
      if (event.type === "door") {
        sfx.play("door");
        toast(`${icon("key")} 铁栅门已开启`);
        await world.openDoor(event.r, event.c);
      }
      if (event.type === "exit") {
        await levelComplete();
        return "over";
      }
    }
    renderHud();
    const monsters = advanceMonsters(board);
    if (monsters.alerts.length) {
      sfx.play("alert");
      outcome = "event";
      const named = monsters.alerts.filter((m) => isVisible(board, m.r, m.c));
      toast(named.length ? `<b>${named.map((m) => m.def.name).join("、")}</b> 发现了${getHeroName()}` : `迷雾中的怪物发现了${getHeroName()}`, "danger");
    }
    await Promise.all(monsters.moves.map((mv) => world.moveMonster(mv.monster, mv.to)));
    if (gen !== levelGen) return "over";
    world.updateFog(board);
    board.monsters.forEach((m) => world.updateMonster(m));
    // 第一次被怪物发现（或被突袭）时，才讲“巡猎的怪物”。
    if (monsters.alerts.length || monsters.ambush) await explain(["ambush"]);
    if (monsters.ambush) {
      const m = monsters.ambush;
      toast(`<b>${m.def.name}</b> 发起突袭`, "danger");
      await world.lunge(world.monsters.get(m.uid).group, world.hero.position);
      await battle(m, false);
      return board.over ? "over" : "battle";
    }
    return outcome;
  } finally {
    if (gen === levelGen) {
      busy = false;
      renderHud();
      refreshMarks();
    }
  }
}

async function pickup(item) {
  if (item.type === "potion") {
    sfx.play("pickup");
    toast(`${icon("potion")} 获得 <b>红心药水</b>`);
  } else if (item.type === "key") {
    sfx.play("pickup");
    toast(`${icon("key")} 获得 <b>钥匙</b>`);
    await world.collectItem(item.r, item.c);
    await explain(["key-door"]);
    return;
  } else if (item.type === "plate") {
    sfx.play("pickup");
    toast(`${icon("armor")} 获得 <b>护甲片</b>`);
  } else if (item.type === "chest") {
    sfx.play("chest");
    const w = WEAPONS[item.weapon];
    toast(`<span class="toast-shape">${shapeSvg(w.shape, { cell: 10 })}</span>获得新武器 <b>${w.name}</b>`, "gold");
  }
  await world.collectItem(item.r, item.c);
  if (item.type === "plate") {
    await explain(["plate"], {});
    return;
  }
  if (item.type !== "chest") return;
  // 拿到新武器时，才讲这件武器带来的新概念：武器槽不够、重武器、护甲。
  const w = WEAPONS[item.weapon];
  const topics = [];
  if (board.hero.weapons.length > board.hero.slots) topics.push("slots");
  if (w.weight === "heavy") topics.push("heavy");
  if (w.pierce) topics.push("armor");
  await explain(topics, { slots: board.hero.slots, weapon: w, weapons: board.hero.weapons, skills: Object.keys(board.hero.skills) });
}

/** 当前已经解锁的战斗机制：看玩家走到的最远章节，回头重玩旧章节不会“忘掉”学过的东西。 */
// 开发者模式下所有机制一开始就全部解锁。
const unlockedFeatures = () => featuresAt(isDevMode() ? LEVELS.length - 1 : Math.max(levelIndex, progress.unlocked - 1));

/**
 * 这场战斗要讲的说明：界面导览只讲已经解锁的部分（看过的会自动跳过，
 * 所以每章第一场战斗只会讲这一章新解锁的按钮），再加上这只怪物自身的特性。
 */
function battleTopics(monster, features) {
  const tour = [
    ["tour-enemy"],
    ["tour-hero"],
    ["tour-intent"],
    ["tour-attack"],
    ["tour-energy", "energy"],
    ["tour-shield", "shield"],
    ["tour-potion", "potion"],
    ["tour-retreat", "retreat"],
  ];
  // 暗王战不能撤退，也就不讲撤退。
  const shown = ([id, feature]) => (!feature || features.has(feature)) && !(id === "tour-retreat" && monster.def.boss);
  const topics = tour.filter(shown).map(([id]) => id);
  // 带着技能进入战斗：讲技能是什么，以及带着的每一个新技能。
  const skills = board.hero.equippedSkills ?? [];
  if (skills.length) topics.push("skills", ...skills.map((id) => ({ id: `skill-${id}`, topic: skillTopic(id) })));
  if (monster.matrix.some((row) => row.some((v) => v >= 2))) topics.push("armor");
  if (monster.def.pattern.some((p) => p.kind === "charge")) topics.push("charge");
  // 回血不在开战时讲：等怪物第一次真的准备回血（心阵上出现虚线框）时再讲怎么打断，见 onHealPlan。
  return topics;
}

async function battle(monster, heroFirst) {
  walkToken += 1;
  clearEngagePin();
  sfx.play("battle");
  const monsterObj = world.monsters.get(monster.uid).group;
  monsterObj.visible = true;
  world.saveView();
  world.faceToward(world.hero, monsterObj.position);
  world.faceToward(monsterObj, world.hero.position);
  await world.focusOn(world.hero.position, monsterObj.position);
  const features = unlockedFeatures();
  const combat = createCombat({ hero: board.hero, monster, heroFirst, features });
  currentCombat = combat;
  closeSheet();
  document.body.classList.add("in-battle");
  // 逐个指着界面讲已经解锁的部分；连击等第一次完美命中、心阵上出现虚线框之后再讲。
  const topics = battleTopics(monster, features);
  const ctx = { weapons: board.hero.weapons, skills: Object.keys(board.hero.skills) };
  sfx.music.play(BATTLE_TRACK[monster.def.id] ?? "battle");
  await runBattle({
    root: $("#battle-root"),
    combat,
    monster,
    world,
    sfx,
    heroFirst,
    features,
    coach: () => explain(topics, ctx, { context: "battle" }),
    afterPerfectHit: features.has("combo") ? () => explain(["combo-energy"]) : null,
    // 怪物第一次准备回血时，讲怎么打断。
    onHealPlan: () => explain(["heal-break"], ctx, { context: "battle" }),
  });
  document.body.classList.remove("in-battle");
  sfx.music.play(combat.phase === "lost" ? null : boardTrack());
  currentCombat = null;
  const events = resolveBattle(board, monster, combat, heroFirst);
  const restore = world.restoreView();
  for (const event of events) {
    if (event.type === "defeat") await world.defeatMonster(event.monster);
    if (event.type === "drop") toast(`${event.monster.def.name}掉落 <b>红心药水</b>`, "gold");
    if (event.type === "exit-open") {
      world.setExitOpen(true);
      sfx.play("win");
      toast("出口封印已解除", "gold");
    }
    if (event.type === "seal-crack") {
      sfx.play("crack");
      toast("王座四周的墨印出现裂痕");
      await world.crackSeals(event.cells);
    }
    if (event.type === "seal-open") {
      sfx.play("toll");
      toast("墨印破除，通往王座的路已经打开", "gold");
      await world.openSeals(event.cells);
    }
    if (event.type === "move") await world.moveHero(event.to);
    if (event.type === "pickup") await pickup(event.item);
  }
  await restore;
  world.updateFog(board);
  if (combat.phase === "fled") world.updateMonster(monster);
  renderHud();
  if (combat.phase === "lost") gameOver();
}

// ——— 关卡与界面 ———

function startLevel(index, { intro = true } = {}) {
  walkToken += 1;
  levelGen += 1;
  levelIndex = index;
  intelUid = null;
  clearEngagePin();
  const level = LEVELS[index];
  // 开发者模式：不读正式存档，直接用满配构筑（全部武器、技能与强化）。
  const dev = isDevMode() ? devLoadout() : null;
  const profile = dev ?? progress.profile;
  // 拥有的武器只算真正从宝箱里拿到的（存在存档里）；跳过的宝箱，武器就还在宝箱里，回去还能拿。
  // 技能按章节学会，次数每章开始时补满。
  const weapons = profile ? [...new Set([...STARTING_WEAPONS, ...profile.weapons])] : weaponsForLevel(index, STARTING_WEAPONS);
  const skills = { ...skillsForLevel(index, SKILLS) };
  for (const id of profile?.skills ?? []) if (SKILLS[id]) skills[id] = SKILLS[id].charges;
  slotsBefore = profile?.slots ?? 0;
  freshSkill = level.skill && !(profile?.skills ?? []).includes(level.skill) ? level.skill : null;
  board = createBoard(level, {
    weapons,
    skills,
    upgrades: sanitizeUpgrades(profile?.upgrades ?? {}),
    equipped: profile?.equipped ?? null,
    equippedSkills: profile?.equippedSkills ?? null,
    knownSkills: profile?.skills ?? [],
    minSlots: profile?.slots ?? 0,
    usedForges: dev ? [] : progress.forged?.[level.key] ?? [],
  });
  world.loadLevel(board);
  sfx.music.play(boardTrack());
  world.controls.autoRotate = false;
  world.setScreenShift(0);
  playing = false;
  busy = false;
  renderHud();
  refreshMarks();
  document.body.classList.add("in-level");
  // 试玩记录：每进入一章（含重玩、重新开始）记一次，只发不收，不影响本机存档。
  if (!dev) recordChapterStart({ name: progress.name, level, index, progress });
  if (intro) showIntro();
  else begin();
}

async function begin() {
  hideScreen();
  const level = board.level;
  const has = (ch) => level.map.some((row) => row.includes(ch));
  const topics = [];
  // 新技能一进章节就到手：先报一声，再排在说明卡最前面讲它是什么（不等第一场战斗）。
  if (freshSkill) {
    toast(`${icon("skill")} 习得新技能 <b>${SKILLS[freshSkill].name}</b>`, "gold");
    topics.push("skills", { id: `skill-${freshSkill}`, topic: skillTopic(freshSkill) });
  }
  // 本章出现按马步移动的怪物（暗影骑士）：讲棋子的走法（排在拾取说明等之前）。
  if (level.monsters.some((m) => MONSTERS[m.type].moves === "knight")) topics.push("chess-moves");
  if (level.tutorial) {
    topics.push("move");
    // 序章：在第一只怪物头顶钉一个“点击发起战斗”的标记，说明卡指着它讲怎么开战；标记一直留到开战。
    const first = board.monsters[0];
    if (first) {
      engagePin = pinMonster(world, first.uid, isTouch() ? "点击怪物，发起战斗" : "单击怪物，发起战斗");
      topics.push("engage");
    }
  }
  if (has("H") || has("P")) topics.push("chest");
  if (slotsBefore && board.hero.slots > slotsBefore) topics.push({ id: `slots-${board.hero.slots}`, topic: TOPICS_SLOTS_UP });
  // 钥匙、巡猎的怪物不在开场讲：分别在拾取钥匙、第一次被怪物发现时再讲。
  if (level.fog) topics.push("fog");
  if (level.monsters.some((m) => MONSTERS[m.type].boss)) topics.push("boss");
  // 学到新技能的章节多讲一张（技能总说明 + 新技能 + 本章机制），新技能的卡片不挤掉本章要讲的机制。
  await explain(topics, { slots: board.hero.slots }, { limit: freshSkill ? TOPICS_PER_MOMENT + 1 : TOPICS_PER_MOMENT });
  playing = true;
  refreshMarks();
}

/** 手机上的底部面板：同一时间只开一块。 */
function openSheet(name) {
  const open = document.body.classList.contains(`sheet-${name}`);
  closeSheet();
  if (!open) document.body.classList.add(`sheet-${name}`, "sheet-open");
}

function closeSheet() {
  document.body.classList.remove("sheet-hero", "sheet-goal", "sheet-open");
}

function showScreen(name, html, { back = null, wide = false } = {}) {
  closeSheet();
  const el = $("#screen");
  // 同一个界面原地刷新（例如构筑里换武器）：只换内容，不重播入场动画，滚动位置保持不变，界面才不会抽动。
  if (screenName === name && !el.hidden && el.classList.contains("open")) {
    screenBack = back;
    const scrolled = [el, el.querySelector(".panel")].map((node) => node?.scrollTop ?? 0);
    el.innerHTML = html;
    [el, el.querySelector(".panel")].forEach((node, i) => node && (node.scrollTop = scrolled[i]));
    return;
  }
  screenName = name;
  screenBack = back;
  el.hidden = false;
  el.className = `screen screen-${name} ${wide ? "wide" : ""}`;
  el.innerHTML = html;
  requestAnimationFrame(() => {
    if (screenName === name) el.classList.add("open");
  });
  $("#tooltip").hidden = true;
}

function hideScreen() {
  screenName = null;
  screenBack = null;
  const el = $("#screen");
  el.className = "screen";
  el.hidden = true;
  el.innerHTML = "";
}

/** 评分用直角小方块表示（瑞士风不用圆润的星形）。 */
function stars(n, total = 3) {
  return `<span class="stars" aria-label="${n} / ${total}">${Array.from({ length: total }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`;
}

const foeGlyphs = (level) =>
  [...new Set(level.monsters.map((m) => m.type))]
    .map((k) => `<i class="avatar-sm ${MONSTERS[k].model}" title="${MONSTERS[k].name}">${GLYPH[MONSTERS[k].model]}</i>`)
    .join("");

/** 有没有值得重置的东西：解锁过章节、拿过星、有构筑存档或看过说明。 */
function hasProgress() {
  return progress.unlocked > 1 || Object.keys(progress.stars ?? {}).length > 0 || Boolean(progress.profile) || progress.seen.length > 0;
}

/** 重置前的确认。不可撤销，所以单独一屏，默认焦点放在「取消」上。 */
function showResetConfirm() {
  const back = screenName && screenBack ? screenBack : null;
  const from = screenName;
  showScreen(
    "reset",
    `<div class="panel reset-panel" role="alertdialog" aria-labelledby="reset-title">
      <header class="panel-head"><div>${kicker(icon("restart"), "重置", "RESET")}<h2 id="reset-title">重置进度</h2></div></header>
      <p class="body">${rich(`所有章节、星级、[武器]、强化与名字都将被清除，游戏将从序章重新开始。`)}</p>
      <p class="reset-warn">${icon("close")}这一步无法撤销。</p>
      <div class="panel-actions">
        <button class="ghost" data-cmd="back" autofocus>取消</button>
        <button class="primary danger" data-cmd="confirmReset">确认重置<span aria-hidden="true">→</span></button>
      </div>
    </div>`,
  );
  // 取消后回到打开前的那一屏。从玩法说明进来的，回去时沿用它原来的关闭方式，棋盘上的状态不会丢。
  screenBack =
    from === "help" && back
      ? () => {
          showHelp();
          screenBack = back;
        }
      : showTitle;
  setTimeout(() => document.querySelector(".reset-panel [data-cmd=back]")?.focus(), 30);
}

function resetProgress() {
  const audio = progress.audio;
  for (const k of Object.keys(progress)) delete progress[k];
  Object.assign(progress, JSON.parse(JSON.stringify(EMPTY_PROGRESS)), audio ? { audio } : {});
  saveProgress();
  // 回到标题；棋盘背景重新从序章开始。进行中的走动和动画一并作废。
  walkToken += 1;
  levelGen += 1;
  playing = false;
  busy = false;
  board = null;
  currentCombat = null;
  document.body.classList.remove("in-level", "in-battle");
  clearEngagePin();
  setHeroName("");
  syncDevMode();
  enterGame();
  toast(`${icon("restart")} 进度已重置`);
}

function showTitle() {
  sfx.music.play("title");
  document.body.classList.remove("in-level");
  clearEngagePin();
  playing = false;
  if (!board) {
    board = createBoard(LEVELS[0], { weapons: STARTING_WEAPONS });
    world.loadLevel(board);
  }
  world.controls.autoRotate = true;
  world.controls.autoRotateSpeed = 0.6;
  world.setScreenShift(0.25);
  const continueIndex = Math.min(progress.unlocked, LEVELS.length) - 1;
  const earned = LEVELS.reduce((sum, l) => sum + (progress.stars[l.key] ?? 0), 0);
  showScreen(
    "title",
    `<div class="title-card">
      <div class="dot-mat" aria-hidden="true"></div>
      <div class="t-meta title-chrome"><span>ADVENTURER · ${getHeroName()}</span></div>
      <h1>心阵<br>棋局</h1>
      <p class="subtitle t-meta">HEART GAMBIT / A TURN-BASED BOARD GAME</p>
      <p class="lede">墨水瓶倾倒在棋盘上，被墨迹侵蚀的黑棋化为怪物。白色小兵${getHeroName()}须穿越${cnNumber(LEVELS.length - 1)}个章节，找到墨迹的源头。</p>
      <div class="title-actions">
        <button class="primary" data-cmd="continue">${progress.unlocked > 1 ? `继续冒险 · 第 ${continueIndex} 章` : "开始冒险"}<span aria-hidden="true">→</span></button>
        <button class="ghost" data-cmd="levels">选择章节</button>
        <button class="ghost" data-cmd="help">玩法说明</button>
        <button class="ghost" data-cmd="rename">更改名字</button>
        ${hasProgress() ? `<button class="ghost subtle" data-cmd="reset">${icon("restart")}重置进度</button>` : ""}
      </div>
      <dl class="title-specs">
        <div><dt class="t-meta">Chapters</dt><dd>${pad(LEVELS.length - 1)}</dd></div>
        <div><dt class="t-meta">Weapons</dt><dd>${pad(Object.keys(WEAPONS).length)}</dd></div>
        <div><dt class="t-meta">Board</dt><dd>8×8</dd></div>
        <div><dt class="t-meta">Stars</dt><dd>${pad(earned)}<small>/${LEVELS.length * 3}</small></dd></div>
      </dl>
    </div>`,
  );
}

/** 进入游戏的第一屏：还没起名就先起名，起过了直接看标题。 */
function enterGame() {
  if (progress.name) showTitle();
  else showNameEntry();
}

/**
 * 起名 / 改名界面。
 * cancelable 为 true 时是从标题页点「更改名字」进来的，可以取消；首次起名必须填完才能继续。
 */
function showNameEntry({ cancelable = false } = {}) {
  sfx.music.play("title");
  document.body.classList.remove("in-level");
  clearEngagePin();
  playing = false;
  // 背景棋盘照常转起来，和标题页保持一致。
  if (!board) {
    board = createBoard(LEVELS[0], { weapons: STARTING_WEAPONS });
    world.loadLevel(board);
  }
  world.controls.autoRotate = true;
  world.controls.autoRotateSpeed = 0.6;
  world.setScreenShift(0);
  showScreen(
    "name",
    nameEntryHtml({ current: progress.name, cancelable, kickerHtml: kicker("00", "起名", "YOUR NAME") }),
    { back: cancelable ? showTitle : null },
  );
  bindNameEntry($("#screen"), (name) => {
    progress.name = setHeroName(name);
    syncDevMode();
    saveProgress();
    sfx.play("click");
    showTitle();
  });
}

function showLevels() {
  const back = board && document.body.classList.contains("in-level") ? "resume" : "title";
  const was = playing;
  playing = false;
  showScreen(
    "levels",
    `<div class="panel">
      <header class="panel-head"><div>${kicker("05", "章节", "CHAPTERS", isDevMode() ? devTag() : "")}<h2>选择章节</h2></div><button class="icon-btn" data-cmd="back" aria-label="返回">${icon("close")}</button></header>
      <div class="level-grid">${LEVELS.map((level, i) => {
        // 开发者模式：所有章节都可以直接选择。
        const locked = !isDevMode() && i >= progress.unlocked;
        return `<button class="level-card ${locked ? "locked" : ""}" data-level="${i}" ${locked ? "disabled" : ""}>
          <span class="level-no">${pad(level.id)}</span>
          <b>${level.name}</b><em class="t-meta">${level.english}</em>
          <span class="level-foes">${foeGlyphs(level)}</span>
          ${locked ? `<span class="lock t-meta">${icon("lock")} Locked</span>` : stars(progress.stars[level.key] ?? 0)}
        </button>`;
      }).join("")}</div>
    </div>`,
    { back, wide: true },
  );
  screenBack = back === "resume" ? () => ((playing = was), hideScreen(), refreshMarks()) : showTitle;
}

/**
 * 章节开场：只交代“这一章讲什么、要做什么”。
 * 红心、敌人、新武器等细节留给棋盘上的信息面板和第一次遇到时的说明卡，不在开场堆一屏。
 */
function showIntro() {
  const level = board.level;
  showScreen(
    "intro",
    `<div class="panel intro">
      <div class="intro-head">
        <span class="num-mega">${pad(level.id)}</span>
        <div>
          <p class="t-meta">Chapter ${pad(level.id)} / ${level.english}</p>
          <h2>${level.name}</h2>
          <p class="story">${level.story}</p>
        </div>
      </div>
      <p class="intro-goal"><span class="t-meta">Objective · 目标</span><span class="intro-goal-text">${rich(level.goalText)}</span></p>
      <p class="tip"><span class="t-meta">Note</span>${rich(level.tip)}</p>
      <div class="panel-actions"><button class="primary" data-cmd="begin">${level.tutorial ? "开始序章" : `开始第 ${level.id} 章`}<span aria-hidden="true">→</span></button></div>
    </div>`,
    { back: null },
  );
}

async function levelComplete() {
  playing = false;
  sfx.music.play(null);
  sfx.play("win");
  const level = board.level;
  const { hearts, slots } = countHearts(board.hero.matrix);
  const healthy = hearts / slots >= 0.5;
  const fast = board.turn <= level.par;
  const earned = 1 + (healthy ? 1 : 0) + (fast ? 1 : 0);
  const last = levelIndex === LEVELS.length - 1;
  const hero = board.hero;
  // 通关奖励的武器（序章的钩镰）：直接放进构筑，有空槽就装上。
  const reward = level.reward && !hero.weapons.includes(level.reward) ? WEAPONS[level.reward] : null;
  if (reward) {
    hero.weapons.push(reward.id);
    if (hero.equipped.length < hero.slots) hero.equipped.push(reward.id);
  }
  // 开发者模式不写正式存档：星级、解锁进度、构筑、铁砧记录都保持原样。
  if (!isDevMode()) saveLevelResult(level, earned, last);
  await world.wait(500);
  if (last) return showEnding(earned);
  showResult(level, { earned, healthy, fast, hearts, slots, reward });
}

/** 把通关结果写进正式存档：星级、解锁下一章、构筑、用过的铁砧。 */
function saveLevelResult(level, earned, last) {
  progress.stars[level.key] = Math.max(progress.stars[level.key] ?? 0, earned);
  progress.unlocked = Math.max(progress.unlocked, Math.min(levelIndex + 2, LEVELS.length));
  const hero = board.hero;
  progress.profile = JSON.parse(
    JSON.stringify({
      weapons: hero.weapons,
      skills: Object.keys(hero.skills),
      upgrades: hero.upgrades,
      equipped: hero.equipped,
      equippedSkills: hero.equippedSkills,
      slots: Math.max(progress.profile?.slots ?? 0, hero.slots),
    }),
  );
  if (board.forgesUsed?.length)
    progress.forged = { ...(progress.forged ?? {}), [level.key]: [...new Set([...(progress.forged?.[level.key] ?? []), ...board.forgesUsed])] };
  if (last) progress.cleared = true;
  saveProgress();
}

/** 通关结算页。 */
function showResult(level, { earned, healthy, fast, hearts, slots, reward }) {
  showScreen(
    "complete",
    `<div class="panel result">
      <p class="t-meta">Chapter ${pad(level.id)} / Complete</p>
      <h2>${level.name}</h2>
      ${stars(earned)}
      <div class="stat-row">
        <div class="stat"><span class="t-meta">Turns</span><b>${pad(board.turn)}</b><small>目标 ${level.par}</small></div>
        <div class="stat"><span class="t-meta">Hearts</span><b>${hearts}</b><small>/ ${slots}</small></div>
        <div class="stat"><span class="t-meta">Battles</span><b>${pad(board.stats.battles)}</b><small>撤退 ${board.stats.retreats}</small></div>
      </div>
      ${reward ? `<p class="reward-line"><span class="t-meta">New weapon · 新武器</span><span class="inline-shape">${shapeSvg(reward.shape, { cell: 10 })}</span><b>${reward.name}</b>${reward.desc}</p>` : ""}
      <ul class="criteria">
        <li class="on"><i></i>抵达出口</li>
        <li class="${healthy ? "on" : ""}"><i></i>剩余红心不少于一半</li>
        <li class="${fast ? "on" : ""}"><i></i>${level.par} 回合内完成</li>
      </ul>
      <div class="panel-actions">
        <button class="ghost" data-cmd="replay">再玩一次</button>
        <button class="primary" data-cmd="next">下一章 · ${LEVELS[levelIndex + 1].name}<span aria-hidden="true">→</span></button>
      </div>
    </div>`,
  );
}

function showEnding(earned) {
  setTimeout(() => sfx.music.play("title"), 2500);
  const total = LEVELS.reduce((sum, l) => sum + (progress.stars[l.key] ?? 0), 0);
  showScreen(
    "ending",
    `<div class="panel result ending">
      <p class="t-meta">Final chapter / Checkmate</p>
      <h2>将死。</h2>
      ${stars(earned)}
      <p class="story">暗王被击败，墨迹退回墨水瓶，黑棋恢复原状。${getHeroName()}回到了第一排。</p>
      <div class="stat-row">
        <div class="stat"><span class="t-meta">Stars</span><b>${pad(total)}</b><small>/ ${LEVELS.length * 3}</small></div>
        <div class="stat"><span class="t-meta">Chapters</span><b>${pad(LEVELS.length - 1)}</b><small>全部完成</small></div>
      </div>
      <div class="panel-actions">
        <button class="ghost" data-cmd="levels">回顾章节</button>
        <button class="primary" data-cmd="title">回到标题<span aria-hidden="true">→</span></button>
      </div>
    </div>`,
  );
}

function gameOver() {
  playing = false;
  sfx.music.play(null);
  showScreen(
    "gameover",
    `<div class="panel result lost">
      <p class="t-meta">Chapter ${pad(board.level.id)} / ${board.level.english}</p>
      <h2>挑战失败</h2>
      <p class="story">${rich(`${getHeroName()}的红心已全部消除。请留意怪物的下一招，并在[重击]到来前使用[防御]。`)}</p>
      <div class="panel-actions">
        <button class="ghost" data-cmd="levels">选择章节</button>
        <button class="primary" data-cmd="replay">重新挑战<span aria-hidden="true">→</span></button>
      </div>
    </div>`,
  );
}

function demoGrid(hitCells, rows = 4, cols = 4, anchor = [0, 0]) {
  const hit = new Set(hitCells.map(([r, c]) => `${r},${c}`));
  let html = "";
  for (let r = 0; r < rows; r += 1)
    for (let c = 0; c < cols; c += 1) {
      const on = hit.has(`${r},${c}`);
      html += `<span class="demo-cell ${on ? "hit" : ""} ${r === anchor[0] && c === anchor[1] ? "anchor" : ""}">${heartSvg("heart")}</span>`;
    }
  return `<div class="demo-grid" style="grid-template-columns:repeat(${cols}, 1fr)">${html}</div>`;
}

/** 玩法说明里的操作一节：键盘设备列按键，触屏设备讲手势。 */
function controlsHelp() {
  if (isTouch())
    return `<h3><span class="t-meta">06</span>操作</h3>
          <p class="keys"><span>方向键 移动</span><span>点格子 自动寻路</span><span>单指拖动 转动视角</span><span>双指 缩放</span><span>攻击：点击格子预览范围，再次点击同一格确认</span><span>信息栏按钮 武器 / 目标 / 药水 / 护甲片</span></p>`;
  return `<h3><span class="t-meta">06</span>按键</h3>
          <p class="keys"><span><kbd>WASD</kbd>移动</span><span><kbd>C</kbd>转动视角</span><span><kbd>B</kbd>构筑</span><span><kbd>G</kbd>护甲片</span><span><kbd>P</kbd>喝药水</span><span><kbd>1</kbd>~<kbd>7</kbd>选武器</span><span><kbd>R</kbd>旋转</span><span><kbd>F</kbd>镜像</span><span><kbd>X</kbd>延长</span><span><kbd>G</kbd>巨化（战斗中）</span><span><kbd>Q</kbd>防御</span><span><kbd>E</kbd>药水</span><span><kbd>Z</kbd>等待</span></p>`;
}

function showHelp() {
  const was = playing;
  playing = false;
  const hook = WEAPONS.hook;
  showScreen(
    "help",
    `<div class="panel help">
      <header class="panel-head"><div>${kicker("00", "规则", "HOW TO PLAY")}<h2>玩法说明</h2></div><button class="icon-btn" data-cmd="back" aria-label="关闭">${icon("close")}</button></header>
      <div class="help-grid">
        <section>
          <h3><span class="t-meta">01</span>红心矩阵</h3>
          <p>${rich(`${getHeroName()}与怪物的生命均以[红心矩阵]表示，红心全部消除的一方战败。带黑框的[护甲心]需要命中两次才会消除。`)}</p>
          <h3><span class="t-meta">02</span>形状攻击</h3>
          <p>${rich(`每件[武器]具有固定的攻击形状，范围内的红心将被消除。<span class="inline-shape">${shapeSvg(hook.shape, { cell: 9 })}</span> 钩镰瞄准 a00 时，消除 a00、a01、a10。`)}</p>
          ${demoGrid([[0, 0], [0, 1], [1, 0]])}
        </section>
        <section>
          <h3><span class="t-meta">03</span>战斗</h3>
          <ul class="help-legend">
            <li><span class="legend-glyph"><span class="swatch ink"></span></span><span>墨黑格为怪物下一招的攻击范围。</span></li>
            <li><span class="legend-glyph"><span class="swatch heal-plan"></span></span><span>红色虚线框为怪物即将恢复红心的位置。</span></li>
            <li><span class="legend-glyph">${icon("shield")}</span><span>${rich("[防御]抵挡怪物的下一次攻击，不消耗回合。")}</span></li>
            <li><span class="legend-glyph">${icon("potion")}</span><span>${rich("[药水]恢复十字范围内的红心。")}</span></li>
            <li><span class="legend-glyph">${icon("cd")}</span><span>${rich("中型与重型武器使用后需要[冷却] 1 回合。")}</span></li>
            <li><span class="legend-glyph">${icon("run")}</span><span>撤退时承受一次追击，之后怪物晕眩两回合。</span></li>
          </ul>
          <h3><span class="t-meta">04</span>连击</h3>
          <ul class="help-legend">
            <li><span class="legend-glyph">${icon("perfect")}</span><span>${rich("攻击范围内的格子全部为红心时，即为[完美命中]，命中位置留下蓝色虚线框。")}</span></li>
            <li><span class="legend-glyph">${icon("combo")}</span><span>${rich("切换武器，且攻击范围与蓝色虚线框相邻，再次完美命中，即构成[连击]。")}</span></li>
            <li><span class="legend-glyph">${icon("energy")}</span><span>${rich(`每次连击获得 ${ENERGY_PER_LINK} 点[充能]。中型武器每次消耗 ${ENERGY_COST.medium} 点，重型武器每次消耗 ${ENERGY_COST.heavy} 点。连击 ×${CHASE_EVERY} 时触发[追击]：敌人行动前再追加一次攻击。`)}</span></li>
          </ul>
          <h3><span class="t-meta">05</span>棋盘</h3>
          <ul class="help-legend">
            <li><span class="legend-glyph">${icon("chest")}</span><span>${rich("进入[宝箱]、[药水]或[护甲片]所在的格子即可拾取。站在[铁砧]相邻的格子上点击铁砧即可使用。")}</span></li>
            <li><span class="legend-glyph">${icon("bag")}</span><span>${rich("[武器槽]数量决定可装备的武器数，[技能]最多装备三个。在[构筑]中更换出战的武器与技能。")}</span></li>
            <li><span class="legend-glyph">${icon("fog")}</span><span>${rich(`[迷雾]中仅显示${getHeroName()}周围的格子。`)}</span></li>
          </ul>
          ${controlsHelp()}
          <div class="panel-actions"><button class="ghost" data-cmd="hints">新手提示 · ${progress.hints === false ? "关" : "开"}</button><button class="ghost subtle" data-cmd="reset">${icon("restart")}重置进度</button></div>
        </section>
      </div>
    </div>`,
    { wide: true },
  );
  screenBack = () => {
    if (document.body.classList.contains("in-level")) {
      hideScreen();
      playing = was;
      refreshMarks();
    } else showTitle();
  };
}

/**
 * 在自己的心阵上摆放一个形状（棋盘上喝药水、上护甲共用）。不消耗回合。
 * resolve(r, c) 给出落在 (r,c) 时会改变的格子；apply(r, c) 真正生效并返回这些改动。
 */
function showHeroPlacement({ name, kickerHtml, title, bodyHtml, shape, resolve, apply, tone, anim, sound }) {
  playing = false;
  showScreen(
    name,
    `<div class="panel heal-panel">
      <header class="panel-head"><div>${kickerHtml}<h2>${title}</h2></div><button class="icon-btn" data-cmd="back" aria-label="关闭">${icon("close")}</button></header>
      <p class="body">${bodyHtml}</p>
      <div class="heal-matrix"><div id="place-matrix"></div></div>
    </div>`,
  );
  const view = new MatrixView($("#place-matrix"), { margin: 1, maxSize: 300, side: "hero" });
  const resume = () => {
    hideScreen();
    playing = true;
    refreshMarks();
  };
  view.set(board.hero.matrix);
  view.onHover = (r, c) => {
    const changes = resolve(r, c);
    view.preview(shape, r, c, changes, { tone, valid: changes.length > 0 });
  };
  view.onLeave = () => view.clearPreview();
  view.onPick = async (r, c) => {
    if (!resolve(r, c).length) {
      sfx.play("invalid");
      return;
    }
    const changes = apply(r, c);
    sfx.play(sound);
    view.clearPreview();
    await view.animate(changes, anim, board.hero.matrix);
    renderHud();
    resume();
  };
  screenBack = resume;
}

/** 棋盘上喝药水：在自己的心阵上选择十字落点。 */
function showFieldHeal() {
  if (!playing || busy || board.hero.potions <= 0 || !unlockedFeatures().has("potion")) return;
  showHeroPlacement({
    name: "heal",
    kickerHtml: kicker("P", "治疗", "POTION", `<em>${board.hero.potions}</em>`),
    title: "红心药水",
    bodyHtml: `选择一个位置，恢复 <span class="inline-shape">${shapeSvg(POTION.shape, { cell: 9, tone: "heal" })}</span> 十字范围内的红心。`,
    shape: POTION.shape,
    resolve: (r, c) => resolveHeal(board.hero.matrix, POTION.shape, r, c),
    apply: (r, c) => {
      const heals = resolveHeal(board.hero.matrix, POTION.shape, r, c);
      board.hero.matrix = applyChanges(board.hero.matrix, heals);
      board.hero.potions -= 1;
      return heals;
    },
    tone: "heal",
    anim: "heal",
    sound: "heal",
  });
}

/** 棋盘上使用护甲片：在自己的心阵上选择一块 2×2 区域，附加护甲。 */
function showFieldArmor() {
  if (!playing || busy || board.hero.plates <= 0) return;
  showHeroPlacement({
    name: "armor",
    kickerHtml: kicker(icon("armor"), "护甲", "ARMOR", `<em>${board.hero.plates}</em>`),
    title: "护甲片",
    bodyHtml: rich(`选择一个位置，为 <span class="inline-shape">${shapeSvg(PLATE_SHAPE, { cell: 9 })}</span> 2×2 范围内的红心附加护甲。[护甲心]首次被击中时失去护甲，第二次被击中时消除。`),
    shape: PLATE_SHAPE,
    resolve: (r, c) => previewPlate(board, r, c),
    apply: (r, c) => armorHero(board, r, c).changes,
    tone: "armor",
    anim: "armor",
    sound: "pickup",
  });
}

/**
 * 手机菜单：竖屏顶栏只留一个菜单按钮，其余按钮收进这里，每一行都有足够的点按高度。
 * 在章节里多出“转动视角 / 重新开始 / 选择章节”；标题页只有说明和声音开关。
 */
function showMenu() {
  if (busy || document.body.classList.contains("in-battle")) return;
  const inLevel = document.body.classList.contains("in-level");
  const was = playing;
  playing = false;
  const row = (cmd, glyph, label, extra = "") =>
    `<button class="menu-row" data-cmd="${cmd}">${icon(glyph)}<span>${label}</span>${extra}</button>`;
  const toggle = (cmd, glyph, label, on) => row(cmd, glyph, label, `<em data-menu-state="${cmd}">${on ? "开" : "关"}</em>`);
  showScreen(
    "menu",
    `<div class="panel menu-panel">
      <header class="panel-head"><div>${kicker(icon("menu"), "菜单", "MENU")}</div><button class="icon-btn" data-cmd="back" aria-label="关闭">${icon("close")}</button></header>
      <nav class="menu-list">
        ${inLevel ? row("levels", "flag", "选择章节") + row("restart", "restart", "重新开始本章") + row("rotate", "orbit", "转动视角") : ""}
        ${row("help", "help", "玩法说明")}
        ${toggle("music", "music", "音乐", sfx.musicEnabled)}
        ${toggle("sound", "sound", "音效", sfx.enabled)}
      </nav>
    </div>`,
  );
  // 关闭菜单回到原来的状态；菜单里跳去别的界面时，由那个界面接管返回。
  screenBack = () => {
    hideScreen();
    playing = was;
    refreshMarks();
  };
  // 从菜单里点“重新开始 / 转动视角”时先把菜单收起来，恢复棋盘状态。
  menuReturn = screenBack;
}

// ——— 命令与输入 ———

/** 手机菜单打开期间，关闭菜单用的回调；菜单项执行前先调用它收起菜单。 */
let menuReturn = null;

/** 从手机菜单里执行的命令：先收起菜单、恢复棋盘状态，再执行。 */
const fromMenu = (fn) => () => {
  if (screenName === "menu" && menuReturn) {
    const back = menuReturn;
    menuReturn = null;
    back();
  }
  fn();
};

const commands = {
  continue: () => startLevel(Math.min(progress.unlocked, LEVELS.length) - 1),
  levels: fromMenu(showLevels),
  menu: showMenu,
  armory: showArmory,
  upgradeHelp: showUpgradeHelp,
  sheetHero: () => openSheet("hero"),
  sheetGoal: () => openSheet("goal"),
  closeSheet,
  reset: showResetConfirm,
  rename: () => showNameEntry({ cancelable: true }),
  confirmReset: resetProgress,
  hints: () => {
    progress.hints = progress.hints === false;
    saveProgress();
    const btn = document.querySelector("[data-cmd=hints]");
    if (btn) btn.textContent = `新手提示 · ${progress.hints ? "开" : "关"}`;
  },
  help: fromMenu(showHelp),
  begin,
  back: () => (screenBack ? screenBack() : hideScreen()),
  title: showTitle,
  replay: () => startLevel(levelIndex),
  next: () => startLevel(levelIndex + 1),
  restart: fromMenu(() => {
    if (!document.body.classList.contains("in-level") || busy || screenName) return;
    const was = playing;
    playing = false;
    showScreen(
      "restart",
      `<div class="panel reset-panel" role="alertdialog" aria-labelledby="restart-title">
        <header class="panel-head"><div>${kicker(icon("restart"), "重来", "RESTART")}<h2 id="restart-title">重新开始本章</h2></div></header>
        <p class="body">返回${board.level.name}的起点。本章已击败的怪物与已拾取的物品将全部复原。</p>
        <div class="panel-actions">
          <button class="ghost" data-cmd="back">取消</button>
          <button class="primary danger" data-cmd="confirmRestart">重新开始<span aria-hidden="true">→</span></button>
        </div>
      </div>`,
    );
    screenBack = () => {
      hideScreen();
      playing = was;
      refreshMarks();
    };
    setTimeout(() => document.querySelector(".reset-panel [data-cmd=back]")?.focus(), 30);
  }),
  confirmRestart: () => {
    startLevel(levelIndex, { intro: false });
    toast(`${icon("restart")} 已回到本章起点`);
  },
  rotate: fromMenu(() => world.rotateView()),
  potion: showFieldHeal,
  armor: showFieldArmor,
  sound: () => {
    sfx.setEnabled(!sfx.enabled);
    progress.audio = { ...(progress.audio ?? {}), sfx: sfx.enabled };
    saveProgress();
    syncAudioButtons();
    if (sfx.enabled) sfx.play("click");
  },
  music: () => {
    sfx.setMusic(!sfx.musicEnabled);
    progress.audio = { ...(progress.audio ?? {}), music: sfx.musicEnabled };
    saveProgress();
    syncAudioButtons();
  },
};

// 浏览器要求先有一次用户操作才能出声：第一次点击或按键时解锁音频，标题音乐随之响起。
for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, () => sfx.unlock(), { once: true, capture: true });

function syncAudioButtons() {
  $("#sound-btn").innerHTML = icon(sfx.enabled ? "sound" : "mute");
  $("#music-btn").innerHTML = icon(sfx.musicEnabled ? "music" : "music-off");
  // 手机菜单里的开关同步显示当前状态。
  const state = { music: sfx.musicEnabled, sound: sfx.enabled };
  for (const el of document.querySelectorAll("[data-menu-state]")) el.textContent = state[el.dataset.menuState] ? "开" : "关";
}
syncAudioButtons();

// 武器面板里拖动换装：在“出战”“闲置”之间拖动武器与技能。战斗中、弹窗打开时不可用（一场战斗只用一套构筑）。
bindLoadoutDrag(
  $("#hero-hud"),
  (move) => {
    const result = moveLoadout(board.hero, move);
    if (!result.ok) {
      sfx.play("invalid");
      toast(result.reason);
      return;
    }
    if (!result.changed) return;
    sfx.play("click");
    renderHud();
    refreshMarks();
  },
  () => Boolean(board) && !busy && !screenName && !document.body.classList.contains("in-battle"),
);

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-cmd]");
  if (btn && !btn.disabled) {
    sfx.unlock();
    if (btn.closest(".screen") || btn.closest(".topbar") || btn.closest(".hud")) sfx.play("click");
    commands[btn.dataset.cmd]?.();
    return;
  }
  // “目标”面板：点怪物那一行展开 / 收起它的情报。
  const foe = e.target.closest("#goal-hud [data-intel]");
  if (foe) {
    sfx.play("click");
    const uid = foe.dataset.intel;
    intelUid = intelUid === uid ? null : uid;
    renderHud();
    return;
  }
  const card = e.target.closest("[data-level]");
  if (card && !card.disabled) {
    sfx.play("click");
    startLevel(Number(card.dataset.level));
  }
});

function moveDir(name) {
  if (!playing || busy || screenName) return;
  const { up, right } = world.screenDirections();
  const d = { up, down: { dr: -up.dr, dc: -up.dc }, right, left: { dr: -right.dr, dc: -right.dc } }[name];
  walkToken += 1;
  step(board.hero.r + d.dr, board.hero.c + d.dc);
}

$("#dpad").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-dir]");
  if (btn) {
    sfx.unlock();
    moveDir(btn.dataset.dir);
  }
});

const KEY_DIRS = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };

document.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("in-battle")) return;
  sfx.unlock();
  const k = e.key.toLowerCase();
  if (screenName) {
    if (k === "escape" && screenBack) commands.back();
    if ((k === "enter" || k === " ") && screenName === "intro") {
      e.preventDefault();
      begin();
    }
    return;
  }
  if (KEY_DIRS[k]) {
    e.preventDefault();
    moveDir(KEY_DIRS[k]);
  } else if (k === "c") commands.rotate();
  else if (k === "h") showHelp();
  else if (k === "r") commands.restart();
  else if (k === "p") showFieldHeal();
  else if (k === "g") showFieldArmor();
  else if (k === "b") showArmory();
  else if (k === "escape") showLevels();
});

// 调试与自动化测试用的只读入口。
window.__heartGambit = {
  get board() {
    return board;
  },
  get busy() {
    return busy;
  },
  get playing() {
    return playing;
  },
  get combat() {
    return currentCombat;
  },
  get audio() {
    const m = sfx.music.current;
    return { state: sfx.context?.state ?? "none", track: m?.name ?? null, steps: m?.step ?? 0, sfx: sfx.enabled, music: sfx.musicEnabled };
  },
  startLevel,
  world,
  /** 直接弹出指定的说明卡（忽略“看过”记录），用于检查每张说明卡在各种屏幕上的排版。 */
  coach: (ids, ctx = {}) =>
    createCoach({ root: $("#coach-root"), enabled: () => true, seen: () => false, markSeen: () => {}, sfx })(ids, {
      slots: board?.hero.slots ?? 2,
      weapons: board?.hero.weapons ?? [],
      skills: Object.keys(board?.hero.skills ?? {}),
      ...ctx,
    }),
};

// 网页字体加载完成后重绘 3D 铭牌，让 Canvas 里的数字也用上 Inter。
document.fonts?.ready.then(() => board?.monsters.forEach((m) => world.updateMonster(m)));

enterGame();
