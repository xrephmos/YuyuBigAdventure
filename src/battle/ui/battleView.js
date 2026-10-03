import { MatrixView } from "./matrixView.js";
import { icon, shapeSvg, heartSvg } from "./icons.js";
import { WEAPONS, SHIELD, POTION } from "../data/weapons.js";
import { SKILLS } from "../data/skills.js";
import { upgradeKeys, upLogos, costMarks, cdMask, chargePips } from "./marks.js";
import { INTENT_TEXT } from "../data/monsters.js";
import { patternListHtml } from "./monsterIntel.js";
import { getHeroName } from "../data/heroName.js";
import { ALL_FEATURES } from "../data/features.js";
import { battleLayout, isTouch } from "./device.js";
import { countHearts, reach, footprint, applyChanges, EMPTY } from "../logic/shapes.js";
import {
  heroAttack,
  heroHeal,
  heroShield,
  heroRetreat,
  heroWait,
  monsterTurn,
  previewAttack,
  previewCombo,
  previewInterrupt,
  interruptible,
  energyCost,
  ENERGY_MAX,
  ENERGY_PER_LINK,
  comboLinks,
  comboLabel,
  CHASE_EVERY,
  previewHeal,
  slotOf,
  slotDef,
  slotShape,
  attackShape,
  slotBlocked,
  heroTransform,
  monsterHits,
  parriedCell,
} from "../logic/combat.js";
import { weaponShape, UPGRADE_TEXT } from "../logic/arsenal.js";

export const GLYPH = { ink: "✹", pawn: "♟", knight: "♞", bishop: "♝", rook: "♜", queen: "♛", king: "♚" };
const MOVE_TEXT = { orth: "直行一格", diag: "斜行一格", king: "八方一格", knight: "马步跳跃" };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 不消耗回合的变形及其快捷键：旋转 R、镜像 F、延长 X、巨化 G。 */
const TRANSFORM_KEYS = { rotate: "R", mirror: "F", extend: "X", giant: "G" };

const INTENT_ICON = { charge: "", heal: heartSvg("heart"), armor: heartSvg("armor"), curse: icon("cd") };

/** 招式形状画在固定高度的一行里：行数越多，格子越小，行高始终不变。 */
const INTENT_SHAPE_H = 34;
const intentCell = (shape) => Math.min(12, Math.floor((INTENT_SHAPE_H - (shape.rows - 1) * 2) / shape.rows));

/**
 * 怪物的下一招：攻击只画形状，其他招式配一个小图标和数值。
 * @param {object} intent 怪物下一招
 * @param {string} outcome 这一招落到主角身上的结果（“−5 ♥”或“格挡”），由调用方算好
 */
function intentHtml(intent, outcome = "") {
  if (!intent) return "";
  const extra =
    intent.kind === "attack"
      ? shapeSvg(intent.shape, { cell: intentCell(intent.shape), gap: 2, tone: "enemy", pivot: false })
      : `<span class="intent-fx ${intent.kind}">${INTENT_ICON[intent.kind] ?? ""}${INTENT_TEXT[intent.kind](intent)}${intent.kind === "curse" ? `<i class="fx-break">${icon("combo")}</i>` : ""}</span>`;
  return `<span class="intent-label t-meta">Next</span><strong>${intent.name}</strong>${extra}${outcome}`;
}

/** 怪物的特性：一眼看出该带什么武器。 */
export function monsterTraits(def) {
  const has = (kind) => def.pattern.some((p) => p.kind === kind);
  const traits = [];
  if (def.armored || has("armor")) traits.push({ key: "armor", glyph: heartSvg("armor"), label: "护甲" });
  if (has("heal")) traits.push({ key: "heal", glyph: `${heartSvg("heart")}<b class="plus">+</b>`, label: "回血" });
  if (has("charge")) traits.push({ key: "charge", glyph: icon("stagger"), label: "蓄力重击" });
  if (has("curse")) traits.push({ key: "curse", glyph: icon("cd"), label: "打断连击" });
  return traits;
}

export const traitChips = (def) =>
  monsterTraits(def)
    .map((t) => `<i class="trait ${t.key}" title="${t.label}">${t.glyph}<span>${t.label}</span></i>`)
    .join("");

/**
 * 战斗窗口：左侧怪物心阵（悬停预览 / 点击出招），右侧主角心阵（显示怪物瞄准、药水治疗）。
 * 返回的 Promise 在玩家确认战斗结果后 resolve。
 */
/** 触屏“再点一次确认”的提示只在前几次出现，玩家熟悉之后就不再打扰。 */
const ARM_HINT_TIMES = 3;
let armHints = 0;

export function runBattle({ root, combat, monster, world, sfx, heroFirst, features = ALL_FEATURES, coach = null, afterPerfectHit = null, onHealPlan = null }) {
  const def = combat.def;
  root.innerHTML = `
  <div class="battle-modal" role="dialog" aria-modal="true" aria-label="战斗">
    <div class="stage-card" data-stage-card hidden></div>
    <div class="battle-card ${def.boss ? "boss" : ""}">
      <header class="battle-head">
        <div class="head-left">
          <div class="energy" data-energy title="充能 · 每次连击获得 ${ENERGY_PER_LINK} 点"></div>
          <div class="combo-badge" data-combo title="连击">${icon("combo", "combo-icon")}<b data-combo-count></b></div>
          <div class="chase-meter" data-chase title="每连上 ${CHASE_EVERY} 下触发一次追击"></div>
        </div>
        <div class="turn-banner" data-banner>己方回合</div>
        <div class="round"><span class="t-meta">Round</span><b data-round>01</b></div>
      </header>
      <div class="arena">
        <section class="side enemy" data-side="enemy">
          <div class="side-head">
            <div class="avatar enemy ${def.model}">${GLYPH[def.model]}</div>
            <div class="who foe-toggle" data-foe-toggle role="button" tabindex="0" aria-expanded="false" title="查看招式循环"><span class="t-meta">Enemy${def.boss ? " · Boss" : ""}</span><h3>${def.name}${icon("help", "foe-info-icon")}</h3><p class="traits">${def.boss ? def.title : traitChips(def) || def.title}</p></div>
            <div class="hp" data-enemy-hp></div>
          </div>
          <div class="intent"><div class="intent-main" data-intent></div><div class="pattern" data-pattern></div></div>
          <div class="matrix-box"><div data-enemy-matrix></div><div class="float-layer" data-enemy-float></div></div>
          <div class="foe-intel" data-foe-intel hidden></div>
        </section>
        <div class="vs" aria-hidden="true"><span class="t-meta">VS</span></div>
        <section class="side hero" data-side="hero">
          <div class="side-head">
            <div class="avatar hero">♙</div>
            <div class="who"><span class="t-meta">Hero</span><h3>${getHeroName()}</h3><p data-hero-status>白色小兵</p></div>
            <div class="hp" data-hero-hp></div>
          </div>
          <div class="aim-note" data-aim-note></div>
          <div class="matrix-box"><div data-hero-matrix></div><div class="float-layer" data-hero-float></div><button class="heal-close" data-heal-close aria-label="取消喝药">${icon("close")}</button></div>
          <div class="heal-bar" data-heal-bar hidden>
            ${icon("potion")}<b>选择恢复位置</b><small>${isTouch() ? "点一下预览，再点一次确认" : "悬停预览，点击确认"}</small>
            <button class="heal-cancel" data-heal-cancel title="取消喝药（Esc）" aria-label="取消喝药">${icon("close")}</button>
          </div>
        </section>
      </div>
      <footer class="battle-foot">
        <div class="weapon-bar" data-weapons role="toolbar" aria-label="武器与技能"></div>
        <div class="transform-bar" data-transform></div>
        <div class="action-bar">
          <button class="action shield" data-act="shield"></button>
          <button class="action potion" data-act="potion"></button>
          <button class="action wait" data-act="wait" title="跳过本回合">${icon("wait")}<span>等待</span><small class="key-hint">Z</small></button>
          <button class="action retreat" data-act="retreat">${icon("run")}<span>撤退</span></button>
        </div>
      </footer>
      <div class="battle-log" data-log aria-live="polite"></div>
      <div class="battle-toast" data-toast></div>
      <div class="battle-result" data-result hidden></div>
    </div>
  </div>`;

  const $ = (sel) => root.querySelector(sel);
  const modal = $(".battle-modal");
  hideLockedParts();
  const layout = battleLayout();
  modal.classList.toggle("landscape", layout === "landscape");
  modal.classList.toggle("portrait", layout === "stacked");
  // 手机横屏：心阵在左、招式在右。
  // 手机竖屏（stacked）：上下排布——怪物心阵占满宽度、吃掉剩余高度（它是出招的地方，要大、好点）；
  // 主角心阵缩在下方一条里，旁边写着怪物下一招会打多少。心阵大小完全由 CSS 排出的外框决定。
  const landscape = layout === "landscape";
  const narrow = layout === "stacked";
  const stacked = narrow;
  const compact = narrow || landscape;
  // 矩阵尺寸同时受宽度和高度约束，保证整张战斗卡片在一屏内。
  const maxSize = landscape
    ? Math.max(120, Math.min((innerWidth - 300) / 2, innerHeight - 150))
    : narrow
      ? Math.max(120, Math.floor((innerWidth - 44) / 2))
      : Math.max(240, Math.min(460, (innerWidth - 220) / 2.3, innerHeight - 520));
  // 怪物心阵四周的界外圈按主角武器的实际覆盖范围来留：锚点在形状左上角的武器，只需要上方和左侧的界外格。
  const enemyMargin = { top: 0, bottom: 0, left: 0, right: 0 };
  // 所有招式在所有可能朝向下的形状（武器可能被强化为可旋转、可镜像、可切换为加长形状）。
  const allShapes = combat.weapons.flatMap((slot) =>
    slot.kind === "skill"
      ? [slotShape(combat, slot)]
      : [0, 1, 2, 3].flatMap((rot) =>
          [false, true].flatMap((flip) => [0, 1, 2].map((ext) => weaponShape(slot.id, combat.upgrades, { rot, flip, ext }))),
        ),
  );
  for (const shape of allShapes) {
    const r = reach(shape);
    enemyMargin.top = Math.max(enemyMargin.top, r.down);
    enemyMargin.bottom = Math.max(enemyMargin.bottom, r.up);
    enemyMargin.left = Math.max(enemyMargin.left, r.right);
    enemyMargin.right = Math.max(enemyMargin.right, r.left);
  }
  // 小屏上界外只留一圈，红心才不会被压得太小。
  if (compact) for (const k of Object.keys(enemyMargin)) enemyMargin[k] = Math.min(enemyMargin[k], 1);
  // 两块心阵的外框等高；矩阵在框内居中，界外格铺满整个外框。竖屏手机的外框高度交给 CSS。
  if (!stacked) for (const box of root.querySelectorAll(".matrix-box")) box.style.height = `${Math.round(maxSize)}px`;
  const enemyBox = $("[data-enemy-matrix]").parentElement;
  const heroBox = $("[data-hero-matrix]").parentElement;
  const enemyView = new MatrixView($("[data-enemy-matrix]"), { margin: enemyMargin, maxSize, side: "enemy", box: enemyBox, minCell: compact ? 12 : 22 });
  // 主角心阵只需容纳药水的十字（每边 1 格）。
  const heroView = new MatrixView($("[data-hero-matrix]"), { margin: compact ? 0 : 1, maxSize, side: "hero", box: heroBox, minCell: compact ? 12 : 22 });
  // 竖屏手机：按外框的新尺寸立刻重排两块心阵（在下方 stacked 分支里赋值）。
  // 喝药浮窗弹出 / 收起时同步调用，第一帧就是新尺寸的格子，动画中途不会再重建一次而“抽一下”。
  let refitNow = () => {};
  // 竖屏手机（B6-A）：主角区左右分布——左边主角心阵，右边名字、红心数和“当前招式”。
  // 旋转 / 镜像 / 延长 / 巨化按钮跟着当前招式放在主角区右下角，不再浮在怪物区里，免得被当成“转动怪物”。
  if (stacked) {
    const tool = document.createElement("div");
    tool.className = "hero-tool";
    tool.dataset.heroTool = "";
    tool.innerHTML = '<span class="tool-shape" data-tool-shape></span><span class="tool-name" data-tool-name></span><span class="tool-fixed">方向固定</span>';
    tool.appendChild($("[data-transform]"));
    $(".side.hero").appendChild(tool);
  }
  // 左右并排时两块心阵共用同一个格子边长，红心一样大；上下排布时各自按自己的外框取最大。
  const syncSize = () => {
    const enemySize = enemyView.fitSize(combat.monsterMatrix.length, combat.monsterMatrix[0].length);
    const heroSize = heroView.fitSize(combat.heroMatrix.length, combat.heroMatrix[0].length);
    if (stacked) {
      enemyView.fixedSize = enemySize;
      heroView.fixedSize = heroSize;
    } else enemyView.fixedSize = heroView.fixedSize = Math.min(enemySize, heroSize);
  };
  syncSize();
  enemyView.set(combat.monsterMatrix);
  heroView.set(combat.heroMatrix);

  const heroEntity = () => world.hero;
  const monsterEntity = () => world.monsters.get(monster.uid)?.group;

  const firstReady = () => combat.weapons.find((w) => w.kind === "weapon" && !slotBlocked(combat, w))?.id;
  let selected = firstReady() ?? combat.weapons[0].id;
  let mode = "attack";
  let busy = !heroFirst;
  let hover = null;
  let done = false;
  let resolveBattle;
  let toastTimer = 0;
  // 战斗结束时要一并清理的监听（例如竖屏的外框尺寸观察）。
  const onDispose = [];

  requestAnimationFrame(() => modal.classList.add("open"));

  function toast(text) {
    const el = $("[data-toast]");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  function flyBean(count) {
    const from = $("[data-enemy-matrix]").getBoundingClientRect();
    const beans = [...$("[data-energy]").querySelectorAll(".bean.on")];
    const to = beans[beans.length - 1]?.getBoundingClientRect() ?? $("[data-energy]").getBoundingClientRect();
    const card = $(".battle-card").getBoundingClientRect();
    for (let k = 0; k < count; k += 1) {
      const bean = document.createElement("i");
      bean.className = "flying-bean";
      bean.innerHTML = icon("energy");
      bean.style.left = `${from.left + from.width / 2 - card.left}px`;
      bean.style.top = `${from.top + from.height / 2 - card.top}px`;
      bean.style.setProperty("--dx", `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
      bean.style.setProperty("--dy", `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
      bean.style.animationDelay = `${k * 90}ms`;
      $(".battle-card").appendChild(bean);
      setTimeout(() => bean.remove(), 800 + k * 90);
    }
    setTimeout(() => {
      $("[data-energy]").classList.remove("pulse");
      void $("[data-energy]").offsetWidth;
      $("[data-energy]").classList.add("pulse");
    }, 520);
  }

  function floatText(side, text, kind) {
    const layer = $(side === "hero" ? "[data-hero-float]" : "[data-enemy-float]");
    const el = document.createElement("span");
    el.className = `float ${kind}`;
    el.textContent = text;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  /**
   * 红心数：“剩余 / 总数”写在同一行，不画血条——剩多少由心阵本身表达。
   * @param {number[][]} matrix 心阵
   * @param {number} loss 本回合预计失去的红心（怪物瞄准主角时显示为红色的 −N）
   */
  function hpHtml(matrix, { loss = 0, lossSlot = false, armorSlot = false } = {}) {
    const { hearts, slots, armor } = countHearts(matrix);
    // 护甲数、−N 这两格一旦可能出现，就整场战斗占着位置（为 0 时只是隐藏），数字不会左右跳。
    const armorHtml = armor || armorSlot ? `<em class="hp-armor ${armor ? "" : "none"}" title="护甲心 ${armor} 颗">${heartSvg("armor")}${armor}</em>` : "";
    const lossHtml = loss || lossSlot ? `<b class="hp-loss ${loss ? "" : "none"}" title="怪物下一招预计消除的红心">−${loss}</b>` : "";
    return `<span class="num">${hearts}</span><span class="of">/ ${slots}</span>${armorHtml}${lossHtml}`;
  }

  // 开战时就带护甲心的一方，护甲数那一格整场保留。
  const armorSlot = { enemy: countHearts(combat.monsterMatrix).armor > 0 || Boolean(def.armored), hero: countHearts(combat.heroMatrix).armor > 0 };

  const keyLabel = (i) => (i < 9 ? String(i + 1) : i === 9 ? "0" : "");

  // 底栏的招式卡：形状画在左上角的小方框里，格子边长按形状大小缩放。
  const cardCell = (shape) => {
    const n = Math.max(shape.rows, shape.cols);
    return Math.min(9, Math.floor((30 - (n - 1) * 2) / n));
  };

  /**
   * 一张招式卡，结构固定：
   *   左上形状 · 右上强化标记
   *   左下名字 · 右下充能消耗（技能是剩余次数）
   * 冷却中整张卡盖上灰色遮罩（沙漏 + 回合数）。
   */
  function moveCard(slot, i) {
    const def = slotDef(slot);
    const weapon = slot.kind === "weapon";
    const cost = energyCost(slot);
    const starved = weapon && !slot.cd && cost > combat.energy;
    const shape = slotShape(combat, slot);
    // 连击中，上一击用过的招式画一圈虚线（和心阵上标出上一击范围的虚线一致）：换一件才接得上。
    const lastUsed = combat.combo > 0 && slot.id === combat.lastWeaponId;
    const classes = [
      "weapon",
      slot.kind,
      slot.id === selected && mode === "attack" ? "selected" : "",
      slotBlocked(combat, slot) ? "cooling" : "",
      lastUsed ? "last-used" : "",
      !weapon && slot.charges <= 0 ? "spent" : "",
      starved ? "starved" : "",
    ].join(" ");
    const meta = weapon ? costMarks(cost) : chargePips(slot.charges, SKILLS[slot.id].charges);
    // 强化标记超过两枚时加上 many：窄屏只显示第一枚，其余收成“+N”。
    // 招式卡只画被动效果类的强化（旋转、镜像、延长有专门的按钮），一行两枚，最多三行。
    const ups = weapon ? upgradeKeys(slot.id, combat.upgrades, { passive: true }).slice(0, 6) : [];
    return `<button class="${classes}" data-weapon="${slot.id}" title="${def.name} · ${def.desc}${lastUsed ? " · 上一击所用武器，无法接续连击" : ""}">
      <span class="weapon-shape">${shapeSvg(shape, { cell: cardCell(shape), gap: 2, tone: weapon ? "attack" : "skill" })}</span>
      <span class="weapon-ups">${upLogos(ups)}</span>
      <span class="weapon-name">${def.name}</span>
      <span class="weapon-meta">${meta}</span>
      <kbd class="key-hint">${keyLabel(i)}</kbd>
      ${weapon ? cdMask(slot.cd) : ""}
    </button>`;
  }

  function renderWeapons() {
    const cards = combat.weapons.map((slot, i) => ({ slot, html: moveCard(slot, i) }));
    const weapons = cards.filter((c) => c.slot.kind === "weapon").map((c) => c.html).join("");
    const skills = cards.filter((c) => c.slot.kind === "skill").map((c) => c.html).join("");
    $("[data-weapons]").innerHTML = `<div class="move-group" aria-label="武器">${weapons}</div>${
      skills ? `<div class="move-group skills" aria-label="技能">${skills}</div>` : ""
    }`;
    // 旋转 / 镜像 / 延长按钮（不消耗回合）：只要带着的武器里有一件拥有这项强化，按钮就一直占着位置，
    // 选中的武器用不了时只是隐藏。这样切换武器时整排高度不变，上面的心阵不会跟着抖一下。
    const slot = slotOf(combat, selected);
    const up = slot?.kind === "weapon" ? combat.upgrades[slot.id] ?? {} : {};
    const owned = (k) => combat.weapons.some((w) => w.kind === "weapon" && combat.upgrades[w.id]?.[k]);
    // 延长、巨化各是一个开关：切到对应范围时，那一枚按钮保持按下的样子。
    const level = { extend: 1, giant: 2 };
    const isToggle = (k) => k in level;
    const on = (k) => isToggle(k) && slot?.orient?.ext === level[k];
    $("[data-transform]").innerHTML = Object.keys(TRANSFORM_KEYS)
      .filter(owned)
      .map((k) => {
        const f = UPGRADE_TEXT[k];
        return `<button class="action transform ${up[k] ? "" : "idle"} ${on(k) ? "on" : ""}" data-transform-kind="${k}" title="${f.name}（${TRANSFORM_KEYS[k]}）" ${up[k] ? "" : 'disabled aria-hidden="true" tabindex="-1"'} ${isToggle(k) ? `aria-pressed="${on(k)}"` : ""}>${icon(f.icon)}<span>${f.name}</span><small class="key-hint">${TRANSFORM_KEYS[k]}</small></button>`;
      })
      .join("");
    if (stacked) renderHeroTool(slot, up);
  }

  /**
   * 竖屏主角区右下角的“当前招式”：缩略形状（跟着旋转、镜像、延长实时变化）+ 名字。
   * 选中的招式没有任何变形强化时，按钮位置写“方向固定”；按钮只是隐藏，这一行的高度不变。
   */
  function renderHeroTool(slot, up) {
    const tool = $("[data-hero-tool]");
    if (!slot) return;
    const shape = slotShape(combat, slot);
    const n = Math.max(shape.rows, shape.cols);
    const cell = Math.min(8, Math.floor((32 - (n - 1) * 2) / n));
    $("[data-tool-shape]").innerHTML = shapeSvg(shape, { cell, gap: 2, tone: slot.kind === "weapon" ? "attack" : "skill" });
    $("[data-tool-name]").textContent = slotDef(slot).name;
    tool.classList.toggle("fixed", !Object.keys(TRANSFORM_KEYS).some((k) => up[k]));
  }

  function renderActions() {
    const shield = $("[data-act=shield]");
    // 防御中、冷却中显示状态；可用时显示快捷键 Q（触屏上隐藏）。
    // 防御中：按钮变蓝；冷却中：盖上和招式卡一样的冷却遮罩。
    shield.innerHTML = `${icon("shield")}<span>${combat.shieldUp ? "防御中" : SHIELD.name}</span><small class="key-hint">Q</small>${cdMask(combat.shieldUp ? 0 : combat.shieldCd)}`;
    shield.disabled = combat.shieldUp || combat.shieldCd > 0;
    shield.classList.toggle("up", combat.shieldUp);
    const potion = $("[data-act=potion]");
    potion.innerHTML = `${icon("potion")}<span>药水</span><b class="count">${combat.potions}</b><small class="key-hint">${mode === "heal" ? "Esc" : "E"}</small>`;
    potion.disabled = combat.potions <= 0;
    potion.classList.toggle("active", mode === "heal");
    const retreat = $("[data-act=retreat]");
    retreat.disabled = !combat.canRetreat;
    retreat.title = combat.canRetreat ? "承受一次追击后脱离战斗，该怪物晕眩两回合" : "本场战斗无法撤退";
  }

  function renderIntent() {
    $("[data-intent]").innerHTML =
      intentHtml(combat.intent, outcomeHtml()) +
      (interruptible(combat) ? `<i class="fx-interrupt" title="重型武器单次消除不少于 3 颗红心即可打断">${icon("stagger")}</i>` : "");
    const len = def.pattern.length;
    // 招式循环画成一排小方块，当前这一招涂黑；名字放在悬停提示里。
    $("[data-pattern]").innerHTML = def.boss
      ? `<i class="unknown" title="情报不明">?</i>`
      : def.pattern
          .map((p, i) => `<i class="${i === combat.step % len ? "now" : ""} ${p.kind}" title="${p.name}"></i>`)
          .join("");
    const aimShape = combat.intent?.kind === "attack" ? combat.intent.shape : null;
    heroView.markAim(aimShape, combat.aim, parriedCell(combat));
    enemyView.markHeal(combat.phase === "hero" ? combat.healPlan : null);
    enemyView.markDoomed(combat.doomed);
    heroView.markDoomed(combat.heroDoomed);
    const note = $("[data-aim-note]");
    if (combat.intent?.kind === "attack" && combat.aim) {
      const hits = previewAim();
      note.innerHTML = combat.shieldUp
        ? `${icon("shield")}<strong>格挡</strong><span class="aim-name">${combat.intent.name}</span>`
        : `<span class="aim-swatch"></span><strong>${combat.intent.name}</strong><b>−${hits}</b>${heartSvg("heart")}`;
      note.className = `aim-note ${combat.shieldUp ? "safe" : "danger"}`;
      $(".battle-card").classList.toggle("shielded", combat.shieldUp);
    } else {
      note.innerHTML = "";
      note.className = "aim-note";
      $(".battle-card").classList.remove("shielded");
    }
  }

  /** 下一招落到主角身上的结果：防御中写“格挡”，否则写会消除几颗红心。 */
  function outcomeHtml() {
    if (combat.intent?.kind !== "attack" || !combat.aim) return "";
    if (combat.shieldUp) return `<span class="intent-dmg safe">${icon("shield")}格挡</span>`;
    // 招架过：伤害预告旁边挂一枚招架标记，表示已经少算了 1 颗。
    const parry = combat.parried ? `<i class="intent-parry" title="招架：少打 1 颗心">${icon("parry")}</i>` : "";
    return `<span class="intent-dmg">−${previewAim()}${heartSvg("heart")}${parry}</span>`;
  }

  /** 本回合主角预计失去的红心数（防御中为 0）。 */
  const aimLoss = () => (combat.intent?.kind === "attack" && combat.aim && !combat.shieldUp ? previewAim() : 0);

  /** 这一招会打掉主角几颗心（已扣除招架），与结算用同一个函数。 */
  const previewAim = () => monsterHits(combat).length;

  /**
   * 追击进度：CHASE_EVERY 格进度 + 追击图标。每连上一下亮一格，亮满时追击图标点亮；
   * 追击之后下一次连上从第一格重新计。
   */
  function renderChase() {
    const links = comboLinks(combat.combo);
    const filled = links ? ((links - 1) % CHASE_EVERY) + 1 : 0;
    const meter = $("[data-chase]");
    meter.classList.toggle("full", filled === CHASE_EVERY);
    meter.innerHTML =
      Array.from({ length: CHASE_EVERY }, (_, k) => `<i class="seg ${k < filled ? "on" : ""} ${k === filled % CHASE_EVERY ? "next" : ""}"></i>`).join("") +
      `<b class="chase-mark">${icon("chase")}</b>`;
  }

  // 左上角：充能一排蓝色菱形，连击标记连上之后才出现。
  function renderCombo() {
    const links = comboLinks(combat.combo);
    const badge = $("[data-combo]");
    badge.classList.toggle("on", links > 0);
    $("[data-combo-count]").textContent = links ? `×${links}` : "";
    $("[data-energy]").innerHTML = Array.from(
      { length: ENERGY_MAX },
      (_, k) => `<i class="bean ${k < combat.energy ? "on" : ""}">${icon("energy")}</i>`,
    ).join("");
  }

  function render() {
    $("[data-round]").textContent = String(combat.round).padStart(2, "0");
    $("[data-enemy-hp]").innerHTML = hpHtml(combat.monsterMatrix, { armorSlot: armorSlot.enemy });
    $("[data-hero-hp]").innerHTML = hpHtml(combat.heroMatrix, { loss: aimLoss(), lossSlot: true, armorSlot: armorSlot.hero });
    $("[data-hero-status]").textContent = combat.shieldUp ? "防御中" : "白色小兵";
    const banner = $("[data-banner]");
    const heroTurn = combat.phase === "hero" && !busy;
    banner.textContent = heroTurn ? (mode === "heal" ? "选择治疗位置" : combat.bonus ? (combat.bonusReason === "chase" ? "追击" : "追加攻击") : "己方回合") : "敌方回合";
    banner.classList.toggle("enemy-turn", !heroTurn);
    modal.classList.toggle("heal-mode", mode === "heal");
    $("[data-heal-bar]").hidden = mode !== "heal";
    modal.classList.toggle("locked", !heroTurn);
    renderWeapons();
    renderActions();
    renderIntent();
    renderCombo();
    renderChase();
    enemyView.markLast(combat.combo > 0 ? combat.lastFootprint : null);
    $("[data-log]").innerHTML = combat.log
      .slice(-3)
      .map((line, i, arr) => `<p class="${i === arr.length - 1 ? "latest" : ""}">${line}</p>`)
      .join("");
    refreshPreview();
  }

  function refreshPreview() {
    enemyView.clearPreview();
    heroView.clearPreview();
    enemyView.el.classList.remove("pv-perfect", "pv-link");
    $(".intent").classList.remove("will-interrupt");
    $("[data-combo]").classList.remove("at-risk", "rising");
    $("[data-chase]").classList.remove("at-risk", "rising");
    if (!hover || busy || combat.phase !== "hero") return;
    if (mode === "attack" && hover.side === "enemy") {
      const slot = slotOf(combat, selected);
      const hits = previewAttack(combat, selected, hover.r, hover.c);
      const ready = !slotBlocked(combat, slot);
      enemyView.preview(attackShape(combat, selected, hover.r, hover.c), hover.r, hover.c, hits, { valid: ready && hits.length > 0 });
      const outcome = ready && hits.length ? previewCombo(combat, selected, hover.r, hover.c) : null;
      enemyView.el.classList.toggle("pv-perfect", outcome && outcome !== "break");
      enemyView.el.classList.toggle("pv-link", outcome === "link");
      if (ready && hits.length && previewInterrupt(combat, selected, hover.r, hover.c)) $(".intent").classList.add("will-interrupt");
      // 连击中：这一击能接上，标记亮起；落空或离上一击太远，标记变成虚线。
      if (outcome && comboLinks(combat.combo)) $("[data-combo]").classList.add(outcome === "link" ? "rising" : "at-risk");
      // 追击进度：这一击能接上时下一格显示斜纹预告；会断连时整排变成虚线。
      if (outcome === "link") $("[data-chase]").classList.add("rising");
      else if (outcome && comboLinks(combat.combo)) $("[data-chase]").classList.add("at-risk");
    }
    if (mode === "heal" && hover.side === "hero") {
      const heals = previewHeal(combat, hover.r, hover.c);
      heroView.preview(POTION.shape, hover.r, hover.c, heals, { tone: "heal", valid: heals.length > 0 });
    }
  }

  enemyView.onHover = (r, c) => {
    hover = { side: "enemy", r, c };
    refreshPreview();
  };
  heroView.onHover = (r, c) => {
    hover = { side: "hero", r, c };
    refreshPreview();
  };
  enemyView.onLeave = heroView.onLeave = () => {
    hover = null;
    refreshPreview();
  };
  // 触屏第一次点下只预览：前几次提醒玩家再点同一格才会出手。
  enemyView.onArm = () => {
    if (armHints >= ARM_HINT_TIMES) return;
    armHints += 1;
    toast("再次点击同一格以确认攻击");
  };
  // 喝药水时顶部的提示条已经写明“再点一次确认”，这里不再弹提示。
  heroView.onArm = () => {
    if (mode === "heal" || armHints >= ARM_HINT_TIMES) return;
    armHints += 1;
    toast("再次点击同一格以确认攻击");
  };
  enemyView.onPick = (r, c) => {
    if (mode === "heal") return toast(`药水只能用于${getHeroName()}的红心矩阵`);
    attack(r, c);
  };
  heroView.onPick = (r, c) => {
    if (mode === "heal") heal(r, c);
    else toast("请在怪物的红心矩阵上选择攻击位置");
  };

  function selectWeapon(id) {
    if (busy || combat.phase !== "hero") return;
    const slot = slotOf(combat, id);
    if (!slot) return;
    const blocked = slotBlocked(combat, slot);
    if (blocked) {
      sfx.play("invalid");
      return toast(blocked);
    }
    selected = id;
    mode = "attack";
    sfx.play("click");
    render();
  }

  async function attack(r, c) {
    if (busy || combat.phase !== "hero") return;
    const result = heroAttack(combat, selected, r, c);
    if (!result.ok) {
      sfx.play("invalid");
      enemyView.shake();
      return toast(result.reason);
    }
    busy = true;
    hover = null;
    const [event] = result.events;
    const broken = event.hits.filter((h) => h.after === 0).length;
    const cracked = event.hits.length - broken;
    // 挥击声分三种：技能、四格以上的重武器、其余轻武器。
    const usedSlot = slotOf(combat, selected);
    const weight = usedSlot.kind === "skill" ? "skill" : WEAPONS[usedSlot.id].weight;
    const heavy = weight === "heavy";
    sfx.play({ skill: "swing-skill", heavy: "swing-heavy", medium: "swing-medium", light: "swing-light" }[weight]);
    const heroObj = heroEntity();
    const target = monsterEntity();
    if (heroObj && target) world.attackAnim(heroObj, target, broken);
    render();
    // 形状先闪一下；重击再顿一拍（打击停顿），碎裂才更有分量。
    enemyView.strike(combat.lastFootprint, { heavy });
    await delay(heavy ? 260 : 140);
    if (heavy) {
      sfx.play("impact", event.hits.length);
      modal.classList.remove("impact");
      void modal.offsetWidth;
      modal.classList.add("impact");
    }
    if (broken) sfx.play("shatter", broken);
    if (cracked) sfx.play("crack");
    floatText("enemy", `-${event.hits.length}`, heavy ? "dmg big" : "dmg");
    enemyView.shake(heavy);
    // 首领进入二阶段时，战斗状态里已经是新心阵：碎心动画先落在旧心阵上，新心阵留给转场演出。
    const reborn = result.events.find((e) => e.type === "rebirth");
    await enemyView.animate(event.hits, "hit", reborn ? applyChanges(enemyView.matrix, event.hits) : combat.monsterMatrix, { heavy });
    if (reborn) {
      await playRebirth(reborn);
      busy = false;
      render();
      return;
    }
    const comboEvent = result.events.find((e) => e.type === "combo");
    const links = comboEvent ? comboLinks(comboEvent.combo) : 0;
    if (links) {
      sfx.play("combo", links);
      floatText("enemy", comboLabel(links), "combo");
      $("[data-combo]").classList.remove("pulse");
      void $("[data-combo]").offsetWidth;
      $("[data-combo]").classList.add("pulse");
      if (comboEvent.energy) {
        // 得到充能：一颗蓝色菱形从心阵飞向左上角的能量条。
        setTimeout(() => {
          sfx.play("energy", comboEvent.energy);
          flyBean(comboEvent.energy);
        }, 180);
      }
    } else if (result.events.some((e) => e.type === "combo-break")) {
      floatText("enemy", "连击中断", "miss");
      sfx.play("combo-break");
    }
    if (comboEvent?.chase) {
      // 连击 ×3 的倍数：追击，怪物行动前再出一招。
      setTimeout(() => {
        sfx.play("chase");
        floatText("enemy", "追击！", "chase");
      }, 300);
    }
    if (result.events.some((e) => e.type === "parry")) {
      setTimeout(() => floatText("hero", "招架", "chase"), 360);
    }
    if (result.events.some((e) => e.type === "interrupt")) {
      sfx.play("stun");
      setTimeout(() => floatText("enemy", "打断！", "chase"), 420);
    }
    const drained = result.events.find((e) => e.type === "heal" && e.side === "hero");
    if (drained) {
      sfx.play("heal");
      floatText("hero", `+${drained.changes.length}`, "heal");
      await heroView.animate(drained.changes, "heal", combat.heroMatrix);
    }
    if (result.events.some((e) => e.type === "won")) return finish();
    // 第一次完美命中、心阵上出现蓝色虚线框：这时候才讲连击。
    if (afterPerfectHit && combat.combo > 0) {
      const explainCombo = afterPerfectHit;
      afterPerfectHit = null;
      render();
      await explainCombo();
    }
    if (combat.phase === "hero") {
      // 追击或突刺之后：仍是主角回合，换一件可用的普通武器。
      if (slotBlocked(combat, slotOf(combat, selected))) selected = firstReady() ?? selected;
      busy = false;
      render();
      return;
    }
    await delay(250);
    await enemyPhase();
  }

  async function heal(r, c) {
    if (busy || combat.phase !== "hero") return;
    const result = heroHeal(combat, r, c);
    if (!result.ok) {
      sfx.play("invalid");
      return toast(result.reason);
    }
    // 恢复动画在浮窗里播完，再收起浮窗，然后才轮到怪物。
    busy = true;
    hover = null;
    sfx.play("heal");
    render();
    floatText("hero", `+${result.events[0].changes.length}`, "heal");
    await heroView.animate(result.events[0].changes, "heal", combat.heroMatrix);
    await delay(200);
    await leaveHealMode();
    await delay(150);
    await enemyPhase();
  }

  /**
   * 首领的标题卡：战斗卡上盖一层墨黑，正中一行大字，停留片刻后淡出。
   */
  async function stageCard(kicker, title, hold = 1300) {
    const card = $("[data-stage-card]");
    card.innerHTML = `<p class="t-meta">${kicker}</p><h2>${title}</h2>`;
    card.hidden = false;
    card.classList.remove("leaving");
    await delay(hold);
    card.classList.add("leaving");
    await delay(380);
    card.hidden = true;
  }

  /** 心阵一行行聚拢出来：开场从上往下，二阶段从下往上（像重新站起来）。 */
  async function assembleEnemy(matrix, { fromBottom = false } = {}) {
    syncSize();
    enemyView.set(matrix.map((row) => row.map((v) => (v > EMPTY ? EMPTY : v))));
    enemyView.relayout();
    const cells = [];
    matrix.forEach((row, r) => row.forEach((v, c) => v > EMPTY && cells.push({ r, c, before: EMPTY, after: v })));
    if (fromBottom) cells.sort((a, b) => b.r - a.r || a.c - b.c);
    await enemyView.animate(cells, "heal", matrix);
  }

  /** 暗王开场：标题卡，然后心阵聚拢。 */
  async function playBossIntro() {
    sfx.play("toll");
    const shown = stageCard("Boss · 终章", `${def.name} · ${def.title}`, 1500);
    await delay(700);
    await assembleEnemy(combat.monsterMatrix);
    await shown;
  }

  /**
   * 二阶段转场：像电影里的一段过场。
   *   1. 心阵清空，音乐淡出；战斗卡隐去，镜头里只剩棋盘上的暗王。
   *   2. 暗王的棋子轰然倒地，墨色碎块溅开；一片死寂。
   *   3. 心跳声一下比一下近，钟声与低鸣涌上来，暗王慢慢重新站起，王冠从此歪着；第二段音乐从无声开始由弱渐强。
   *   4. 标题「王冠倾斜」，战斗卡回来，新形状的心阵从下往上重新聚拢。
   */
  async function playRebirth(event) {
    const king = monsterEntity();
    await delay(450);
    sfx.music.play(null, { fadeOut: 1.4 });
    modal.classList.add("cinematic");
    await delay(650);
    sfx.play("topple");
    if (king) await world.toppleBoss(king);
    await delay(1100);
    for (const [i, gap] of [900, 760, 620].entries()) {
      sfx.play("heartbeat", i);
      await delay(gap);
    }
    sfx.play("rebirth");
    sfx.music.play("boss2", { fadeIn: 16 });
    if (king) await world.raiseBoss(king);
    await stageCard("Phase II · 第二阶段", event.title, 1500);
    $(".side.enemy .traits").textContent = event.title;
    modal.classList.remove("cinematic");
    modal.classList.add("rebirth");
    await delay(380);
    await assembleEnemy(combat.monsterMatrix, { fromBottom: true });
    modal.classList.remove("rebirth");
  }

  /** 收起浮窗用的时长，与 phone.css 里 heal-close 动画一致。 */
  const HEAL_CLOSE_MS = 170;
  /** 弹出浮窗用的时长，与 phone.css 里 heal-pop 动画一致。 */
  const HEAL_POP_MS = 260;
  /** 怪物一次打掉这么多颗心算重击：弹出浮窗、加重震动与音效。 */
  const HEAVY_HIT = 4;

  /**
   * 怪物重击：竖屏手机上主角心阵很小，被重击时和喝药一样弹出放大的浮窗，
   * 浮窗里先标出这一招盖住的格子，再演示红心被打碎。其余布局心阵本来就够大，不弹窗。
   * 返回是否弹出了浮窗。
   */
  async function openHurtPop(event) {
    if (!stacked) return false;
    modal.classList.add("hurt-pop");
    refitNow();
    // 浮窗里的格子是按新尺寸重建的，把这一招的墨黑格重新标上。
    if (event.anchor) heroView.markAim(event.intent.shape, event.anchor);
    await delay(HEAL_POP_MS);
    return true;
  }

  async function closeHurtPop() {
    modal.classList.add("heal-closing");
    await delay(HEAL_CLOSE_MS);
    modal.classList.remove("heal-closing", "hurt-pop");
    refitNow();
  }

  /**
   * 退出喝药状态。竖屏手机上先播放浮窗收起的动画，再切回普通布局并立刻按原尺寸重排心阵；
   * 其余布局没有浮窗，直接切回。
   */
  async function leaveHealMode() {
    if (stacked && mode === "heal") {
      modal.classList.add("heal-closing");
      await delay(HEAL_CLOSE_MS);
      modal.classList.remove("heal-closing");
    }
    mode = "attack";
    render();
    refitNow();
  }

  /**
   * 还没解锁的机制不出现在界面上：序章只有攻击，连击与充能、防御、药水、等待、撤退按章节陆续出现。
   * 一排动作按钮全都没解锁时，整排收起来。
   */
  function hideLockedParts() {
    const locked = (feature) => !features.has(feature);
    $("[data-energy]").hidden = locked("energy");
    $("[data-combo]").hidden = locked("combo");
    $("[data-chase]").hidden = locked("combo");
    for (const act of ["shield", "potion", "wait", "retreat"]) $(`[data-act=${act}]`).hidden = locked(act);
    $(".action-bar").hidden = ["shield", "potion", "wait", "retreat"].every(locked);
  }

  function shield() {
    if (busy || !features.has("shield")) return;
    const result = heroShield(combat);
    if (!result.ok) {
      sfx.play("invalid");
      return toast(result.reason);
    }
    sfx.play("shield");
    render();
  }

  async function wait() {
    if (busy || !features.has("wait")) return;
    const result = heroWait(combat);
    if (!result.ok) return;
    busy = true;
    floatText("hero", "等待", "miss");
    render();
    await delay(200);
    await enemyPhase();
  }

  async function retreat() {
    if (busy || !features.has("retreat")) return;
    const result = heroRetreat(combat);
    if (!result.ok) {
      sfx.play("invalid");
      return toast(result.reason);
    }
    busy = true;
    render();
    await delay(200);
    await enemyPhase();
  }

  async function enemyPhase() {
    busy = true;
    render();
    await delay(heroFirst || combat.round > 1 ? 380 : 650);
    const linksBefore = comboLinks(combat.combo);
    const result = monsterTurn(combat);
    const heroObj = heroEntity();
    const target = monsterEntity();
    for (const event of result.events) {
      if (event.type === "monster-attack") {
        if (target && heroObj) world.attackAnim(target, heroObj, event.hits.length);
        // 重击（一次打掉 HEAVY_HIT 颗及以上）：主角心阵弹出放大的浮窗（竖屏手机），先闪出这一招盖住的格子，再在浮窗里碎心。
        // 两三颗心的普通攻击照常在原地碎心，不打断节奏。
        const heavy = event.hits.length >= HEAVY_HIT;
        const popped = heavy && (await openHurtPop(event));
        if (!popped) await delay(170);
        if (event.anchor) {
          heroView.strike(footprint(event.intent.shape, event.anchor.r, event.anchor.c), { heavy, foe: !event.blocked });
          await delay(heavy ? 240 : 150);
        }
        if (event.blocked) {
          sfx.play("block");
          floatText("hero", "格挡", "block");
          $('[data-side="hero"]').classList.add("blocked");
          setTimeout(() => $('[data-side="hero"]')?.classList.remove("blocked"), 700);
          await delay(500);
        } else if (event.hits.length) {
          sfx.play("hurt");
          if (heavy) sfx.play("impact", event.hits.length);
          floatText("hero", `-${event.hits.length}`, heavy ? "dmg big" : "dmg");
          heroView.shake(heavy);
          modal.classList.add("hurt");
          setTimeout(() => modal.classList.remove("hurt"), 400);
          await heroView.animate(event.hits, "hit", combat.heroMatrix, { heavy });
          if (event.doomed?.length) {
            // 死灭：打空的格子画上 ×，本场战斗补不回来。
            sfx.play("curse");
            heroView.markDoomed(combat.heroDoomed);
            floatText("hero", "死灭", "curse");
            await delay(380);
          }
        } else {
          floatText("hero", "未命中", "miss");
          await delay(400);
        }
        if (popped) {
          // 让玩家看清少了哪几颗心，再收起浮窗。
          await delay(420);
          await closeHurtPop();
        }
      } else if (event.type === "charge") {
        sfx.play("charge");
        floatText("enemy", "蓄力", "charge");
        $('[data-side="enemy"]').classList.add("charging");
        setTimeout(() => $('[data-side="enemy"]')?.classList.remove("charging"), 900);
        await delay(650);
      } else if (event.type === "heal") {
        sfx.play("pray");
        if (event.changes.length) floatText("enemy", `+${event.changes.length}`, "heal");
        await enemyView.animate(event.changes, "heal", combat.monsterMatrix);
      } else if (event.type === "armor") {
        sfx.play("fortify");
        floatText("enemy", "护甲", "armor");
        await enemyView.animate(event.changes, "armor", combat.monsterMatrix);
      } else if (event.type === "interrupted") {
        sfx.play("block");
        floatText("enemy", "被打断", "charge");
        await delay(650);
      } else if (event.type === "stunned") {
        sfx.play("stun");
        floatText("enemy", "定身", "charge");
        await delay(650);
      } else if (event.type === "curse") {
        sfx.play(event.blocked ? "block" : "curse");
        floatText("hero", event.blocked ? "格挡" : `冷却 +${event.amount}`, event.blocked ? "block" : "curse");
        if (!event.blocked && linksBefore) setTimeout(() => floatText("enemy", "连击中断", "miss"), 200);
        await delay(550);
      }
    }
    enemyView.set(combat.monsterMatrix);
    heroView.set(combat.heroMatrix);
    if (combat.phase !== "hero") return finish();
    if (slotBlocked(combat, slotOf(combat, selected))) selected = firstReady() ?? selected;
    await beginHeroTurn();
  }

  /**
   * 轮到主角出手。怪物第一次准备回血（心阵上出现红色虚线框）时，先停下来讲怎么打断这次回血：
   * 这时候虚线框就摆在眼前，比开战前讲更容易看懂。只讲一次。
   */
  async function beginHeroTurn() {
    if (onHealPlan && combat.intent?.kind === "heal" && combat.healPlan?.length) {
      const explainHeal = onHealPlan;
      onHealPlan = null;
      busy = true;
      render();
      await explainHeal();
    }
    busy = false;
    render();
  }

  function finish() {
    busy = true;
    render();
    const box = $("[data-result]");
    const outcome = combat.phase;
    const text = {
      won: [def.boss ? "将死" : "胜利", combat.stats.taken ? `${def.name}被击败。本场战斗损失 ${combat.stats.taken} 颗红心。` : `${def.name}被击败。${getHeroName()}未损失红心。`, "继续"],
      lost: ["战斗失败", `${getHeroName()}的红心已全部消除。`, "查看结果"],
      fled: ["撤退成功", `${def.name}晕眩两回合。`, "返回棋盘"],
    }[outcome];
    sfx.play(outcome === "won" ? "victory" : outcome === "lost" ? "defeat" : "step");
    box.className = `battle-result ${outcome}`;
    const meta = { won: "Victory", lost: "Defeat", fled: "Retreat" }[outcome];
    box.innerHTML = `<div class="result-inner"><p class="t-meta">${meta} · Round ${String(combat.round).padStart(2, "0")}</p><h2>${text[0]}</h2><p>${text[1]}</p><button class="primary" data-continue autofocus>${text[2]}<span aria-hidden="true">→</span></button></div>`;
    box.hidden = false;
    box.querySelector("[data-continue]").addEventListener("click", close);
    setTimeout(() => box.querySelector("[data-continue]")?.focus(), 50);
  }

  function close() {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onKey);
    for (const dispose of onDispose) dispose();
    modal.classList.remove("open");
    modal.classList.add("closing");
    setTimeout(() => {
      root.innerHTML = "";
      resolveBattle(combat);
    }, 260);
  }

  function onKey(e) {
    if (done) return;
    if (!$("[data-result]").hidden) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        close();
      }
      return;
    }
    const digit = "1234567890".indexOf(e.key);
    if (digit >= 0 && digit < combat.weapons.length) selectWeapon(combat.weapons[digit].id);
    else if (e.key === "r" || e.key === "R") transform("rotate");
    else if (e.key === "f" || e.key === "F") transform("mirror");
    else if (e.key === "x" || e.key === "X") transform("extend");
    else if (e.key === "g" || e.key === "G") transform("giant");
    else if (e.key === "q" || e.key === "Q") shield();
    else if (e.key === "z" || e.key === "Z") wait();
    else if (e.key === "e" || e.key === "E") togglePotion();
    else if (e.key === "Escape" && mode === "heal") cancelHeal();
  }

  /** 取消喝药：回到攻击状态，药水不消耗；点过一次的预览也一并清掉。 */
  async function cancelHeal() {
    if (mode !== "heal" || busy) return;
    hover = null;
    heroView.disarm();
    sfx.play("click");
    busy = true;
    await leaveHealMode();
    busy = false;
    render();
    refreshPreview();
  }

  function togglePotion() {
    if (busy || combat.phase !== "hero" || !features.has("potion")) return;
    if (combat.potions <= 0) {
      sfx.play("invalid");
      return toast("药水已用尽");
    }
    if (mode === "heal") return cancelHeal();
    // 进入喝药状态：两块心阵上点过一次的格子都作废，主角心阵（竖屏上会放大）要重新点两下。
    mode = "heal";
    hover = null;
    enemyView.disarm();
    heroView.disarm();
    sfx.play("click");
    render();
    // 竖屏：浮窗的外框已经变大，立刻按新尺寸重排，弹出动画的第一帧就是放大后的格子。
    refitNow();
    refreshPreview();
  }

  function transform(kind) {
    if (busy || combat.phase !== "hero") return;
    const result = heroTransform(combat, selected, kind);
    if (!result.ok) {
      sfx.play("invalid");
      return toast(result.reason);
    }
    sfx.play("click");
    render();
  }

  /**
   * 怪物情报小卡：点怪物名字弹出（手机上没有悬停，看不到招式循环），再点一次或点别处收起。
   * 内容是整套招式循环，下一招标出 NEXT；首领的情报隐藏。
   */
  const foeIntel = $("[data-foe-intel]");
  const foeToggle = $("[data-foe-toggle]");
  function setFoeIntel(open) {
    foeIntel.hidden = !open;
    foeToggle.setAttribute("aria-expanded", String(open));
    if (!open) return;
    foeIntel.innerHTML = def.boss
      ? '<p class="intel-unknown t-meta">情报不明</p>'
      : `<p class="t-meta">招式循环 · PATTERN</p>${patternListHtml(def, combat.step % def.pattern.length)}`;
  }
  foeToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setFoeIntel(foeIntel.hidden);
  });
  // 点到情报卡以外的任何地方都收起（点卡片本身不收起，方便细看）。
  modal.addEventListener("click", (e) => {
    if (!foeIntel.hidden && !e.target.closest("[data-foe-intel]")) setFoeIntel(false);
  });

  $("[data-transform]").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-transform-kind]");
    if (btn) transform(btn.dataset.transformKind);
  });
  $("[data-weapons]").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-weapon]");
    if (btn) selectWeapon(btn.dataset.weapon);
  });
  $("[data-act=shield]").addEventListener("click", shield);
  $("[data-act=potion]").addEventListener("click", togglePotion);
  $("[data-heal-cancel]").addEventListener("click", cancelHeal);
  $("[data-heal-close]").addEventListener("click", cancelHeal);
  $("[data-act=retreat]").addEventListener("click", retreat);
  $("[data-act=wait]").addEventListener("click", wait);
  modal.addEventListener("contextmenu", (e) => {
    if (mode === "heal") {
      e.preventDefault();
      mode = "attack";
      render();
    }
  });
  document.addEventListener("keydown", onKey);

  render();
  // 竖屏手机：招式栏、变形按钮排好之后怪物心阵的外框才定下来；外框大小变了（例如出现旋转按钮）就按新尺寸重排。
  if (stacked) {
    let pending = 0;
    // 上一次排版时每块心阵的“格子边长 + 外框尺寸”。两块分开记：谁变了只重建谁，
    // 例如喝药时只有主角心阵变成放大的浮窗，怪物心阵一格都不动，不会跟着闪一下。
    const applied = new Map();
    const fitKey = (view, box) => [view.fixedSize, box.clientWidth, box.clientHeight].join(",");
    const refit = () => {
      pending = 0;
      syncSize();
      let changed = false;
      for (const [view, box] of [[enemyView, enemyBox], [heroView, heroBox]]) {
        const now = fitKey(view, box);
        if (applied.get(view) === now) continue;
        applied.set(view, now);
        view.relayout();
        changed = true;
      }
      // 有心阵重建过，瞄准预览要按新的格子重新画。
      if (changed) refreshPreview();
    };
    refit();
    refitNow = refit;
    const observer = new ResizeObserver(() => {
      if (!pending) pending = requestAnimationFrame(refit);
    });
    observer.observe(enemyBox);
    // 喝药水时主角心阵变成放大的浮窗，外框尺寸变了也要按新尺寸重排。
    observer.observe(heroBox);
    onDispose.push(() => observer.disconnect());
  }
  // 招式很多时底部会折成两行：若整张卡片超出屏幕，就把两块心阵的外框压矮，再按新尺寸重建。
  const card = $(".battle-card");
  const overflow = card.getBoundingClientRect().height - (innerHeight - 24);
  if (overflow > 0 && !compact) {
    const height = Math.max(200, Math.round(maxSize - overflow));
    for (const box of root.querySelectorAll(".matrix-box")) box.style.height = `${height}px`;
    syncSize();
    enemyView.relayout();
    heroView.relayout();
    render();
  }
  (async () => {
    if (def.boss) {
      busy = true;
      render();
      await playBossIntro();
    }
    if (coach) {
      busy = true;
      render();
      await coach();
    }
    if (!heroFirst) enemyPhase();
    else await beginHeroTurn();
  })();

  return new Promise((resolve) => {
    resolveBattle = resolve;
  });
}

export { MOVE_TEXT };
