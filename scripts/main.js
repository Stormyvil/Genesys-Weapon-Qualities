const MODULE_ID = "genesys-weapon-qualities";
const DEFAULT_QUALITY_MAP = {
  Accurate:   { glyphs: ["B"], rated: true  },  
  Inaccurate: { glyphs: ["S"], rated: true  },   
  Inferior:   { glyphs: ["h"], rated: false },   
  Superior:   { glyphs: ["a"], rated: false },  
};

const GLYPH_META = {
  B: { entity: "Boost",      color: "#72cddc" },
  S: { entity: "Setback",    color: "#1e1e1e" },
  A: { entity: "Ability",    color: "#41ad49" },
  P: { entity: "Proficiency",color: "#fff200" },
  D: { entity: "Difficulty", color: "#522380" },
  C: { entity: "Challenge",  color: "#761213" },
  "^": { entity: "UpgradeAbility",    color: "#41ad49", icon: "fa-arrow-up"   },
  "*": { entity: "DowngradeAbility",  color: "#fff200", icon: "fa-arrow-down" },
  "_": { entity: "UpgradeDifficulty", color: "#522380", icon: "fa-arrow-up"   },
  "~": { entity: "DowngradeDiff",     color: "#761213", icon: "fa-arrow-down" },
  a: { entity: "Advantage", color: "#41ad49", isSymbol: true },
  h: { entity: "Threat",    color: "#761213", isSymbol: true },
  s: { entity: "Success",   color: "#fff200", isSymbol: true },
  f: { entity: "Failure",   color: "#522380", isSymbol: true },
  t: { entity: "Triumph",   color: "#ffd700", isSymbol: true },
  d: { entity: "Despair",   color: "#8b0000", isSymbol: true },
};

const GLYPH_TO_DENOM = { B:"db", S:"ds", A:"da", P:"dp", D:"di", C:"dc" };
const DENOM_TO_ENTITY = { db:"Boost", ds:"Setback", da:"Ability", dp:"Proficiency", di:"Difficulty", dc:"Challenge" };

let _pendingAttack = null; 

function getQualityMap() {
  try {
    const custom = JSON.parse(game.settings.get(MODULE_ID, "customQualities") || "{}");
    return { ...DEFAULT_QUALITY_MAP, ...custom };
  } catch {
    return { ...DEFAULT_QUALITY_MAP };
  }
}

function getWeaponQualityGroups(weapon) {
  const qualities = weapon?.systemData?.qualities ?? [];
  const map = getQualityMap();
  const groups = [];
  const allGlyphs = [];

  for (const q of qualities) {
    const entry = map[q.name];
    if (!entry) continue;
    const times = entry.rated ? (q.rating ?? 1) : 1;
    const glyphs = [];
    for (let i = 0; i < times; i++) glyphs.push(...entry.glyphs);
    const label = q.name + (q.isRated ? ` ${q.rating}` : "");
    groups.push({ label, glyphs, qualityName: q.name });
    allGlyphs.push(...glyphs);
  }
  return { groups, allGlyphs };
}

function glyphsToFormula(glyphs) {
  const counts = {};
  for (const g of glyphs) {
    const d = GLYPH_TO_DENOM[g];
    if (d) counts[d] = (counts[d] ?? 0) + 1;
  }
  return Object.entries(counts).map(([d, n]) => `${n}${d}`).join(" ");
}

function parseGenesysRoll(roll) {
  const faces = {};
  const rawSym = { a:0, s:0, t:0, h:0, f:0, d:0 };

  for (const die of roll.dice) {
    const denom = (die.denomination ?? die.constructor?.DENOMINATION ?? "?").toLowerCase();
    if (!faces[denom]) faces[denom] = [];
    for (const result of die.results) {
      const label = typeof die.getResultLabel === "function"
        ? die.getResultLabel(result) : String(result.result ?? "");
      faces[denom].push(label);
      for (const ch of label) { if (ch in rawSym) rawSym[ch]++; }
    }
  }
  return { faces, rawSym };
}

function mergeFaces(a, b) {
  const out = { ...a };
  for (const [denom, arr] of Object.entries(b)) {
    out[denom] = out[denom] ? [...out[denom], ...arr] : [...arr];
  }
  return out;
}

function readEnabledGlyphs(form, allGlyphs) {
  if (!form) return [...allGlyphs];
  const boxes = form.querySelectorAll(".gwq-quality-checkbox");
  if (!boxes.length) return [...allGlyphs];
  const result = [];
  for (const cb of boxes) {
    if (cb.checked) {
      try { result.push(...JSON.parse(cb.dataset.glyphs)); } catch {}
    }
  }
  return result;
}

function buildGlyphBadge(glyph) {
  const meta = GLYPH_META[glyph];
  if (!meta) return "";

  const charContent = meta.isSymbol
    ? glyph                                          
    : (GLYPH_TO_DENOM[glyph] ? glyph : glyph);      

  const iconClass = meta.icon ?? "fa-plus";
  const colorStyle = [
    `color:${meta.color}`,
    "-webkit-text-stroke:0.5px black",
    "text-stroke:0.5px black",
  ].join(";");

  return `<a data-pool-entity="${meta.entity}" style="
      display:inline-flex;flex-direction:row;flex-wrap:nowrap;
      align-items:flex-start;font-family:'Genesys Symbols',sans-serif;
      margin-right:0.2rem;cursor:default;${colorStyle}"
    >${charContent}<i class="fas ${iconClass}" style="color:black;position:relative;font-size:0.5em;top:-0.25em;"></i></a>`;
}

function buildQualityRow(group) {
  const badgeHtml = group.glyphs.map(buildGlyphBadge).join("");
  const glyphsJson = JSON.stringify(group.glyphs).replace(/"/g, "&quot;");
  return `
    <div class="pool-modifications-effects gwq-quality-effects"
         style="display:grid;grid-template-columns:2fr 1.2fr;border-bottom:1px dotted black;min-height:1.2rem;">
      <span style="padding-right:4px;display:flex;align-items:center;gap:4px;">
        <input type="checkbox"
               class="gwq-quality-checkbox"
               data-glyphs="${glyphsJson}"
               checked
               style="border:none;background:none;border-radius:0;padding:0;margin:0;height:1em;">
        <label style="margin:0;"> ${group.label}</label>
      </span>
      <div style="border-left:1px dotted black;padding-left:0.5rem;display:flex;align-items:center;">
        ${badgeHtml}
      </div>
    </div>`;
}
async function applyQualityModsToMessage(data, pending) {
  const { weapon, actor, form, allGlyphs } = pending;

  const enabledGlyphs = readEnabledGlyphs(form, allGlyphs);
  if (!enabledGlyphs.length) return data;
  const addGlyphs     = enabledGlyphs.filter(g => GLYPH_TO_DENOM[g]);
  const upgradeGlyphs = enabledGlyphs.filter(g => "^*_~".includes(g));
  const symbolGlyphs  = enabledGlyphs.filter(g => "ashftd".includes(g) && g.length === 1);
  const extraFormula  = glyphsToFormula(addGlyphs);
  let originalRoll = data.rolls?.[0];
  if (!originalRoll) return data;
  if (typeof originalRoll === "string") {
    try { originalRoll = Roll.fromJSON(originalRoll); }
    catch { return data; }
  }
  if (!(originalRoll instanceof Roll)) {
    try { originalRoll = Roll.fromData(originalRoll); }
    catch { return data; }
  }

  const { faces: origFaces, rawSym: origRawSym } = parseGenesysRoll(originalRoll);
  const declaredSym = originalRoll.data?.symbols ?? {};

  let mergedFaces = { ...origFaces };
  let mergedRawSym = { ...origRawSym };
  const allRolls = [
    (typeof data.rolls[0] === "string")
      ? data.rolls[0]
      : (originalRoll.toJSON?.() ?? originalRoll),
  ];
  if (extraFormula) {
    let extraRoll;
    try {
      extraRoll = new Roll(extraFormula, originalRoll.data ?? {});
      await extraRoll.evaluate();
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to evaluate extra dice:`, err);
      return data; 
    }
    const { faces: eFaces, rawSym: eRawSym } = parseGenesysRoll(extraRoll);
    mergedFaces = mergeFaces(mergedFaces, eFaces);
    for (const k of Object.keys(mergedRawSym)) mergedRawSym[k] += eRawSym[k] ?? 0;
    allRolls.push(extraRoll.toJSON?.() ?? extraRoll);
  }
  for (const g of upgradeGlyphs) {
    let fromDenom, toDenom;
    if      (g === "^") { fromDenom = mergedFaces["a"]?.length ? "a" : null; toDenom = "p"; }
    else if (g === "*") { fromDenom = mergedFaces["p"]?.length ? "p" : null; toDenom = "a"; }
    else if (g === "_") { fromDenom = mergedFaces["i"]?.length ? "i" : null; toDenom = "c"; }
    else if (g === "~") { fromDenom = mergedFaces["c"]?.length ? "c" : null; toDenom = "i"; }
    if (!toDenom) continue;
    if (fromDenom && mergedFaces[fromDenom]?.length > 0) {
      const removed = mergedFaces[fromDenom].pop();
      for (const ch of (removed ?? "")) {
        if (ch in mergedRawSym) mergedRawSym[ch] = Math.max(0, mergedRawSym[ch] - 1);
      }
    }
    try {
      const repRoll = new Roll(`1d${toDenom}`, originalRoll.data ?? {});
      await repRoll.evaluate();
      const { faces: rFaces, rawSym: rSym } = parseGenesysRoll(repRoll);
      mergedFaces = mergeFaces(mergedFaces, rFaces);
      for (const k of Object.keys(mergedRawSym)) mergedRawSym[k] += rSym[k] ?? 0;
      allRolls.push(repRoll.toJSON?.() ?? repRoll);
    } catch (err) {
      console.warn(`${MODULE_ID} | Replacement roll 1d${toDenom} failed:`, err);
    }
  }
  const finalRawSym = { ...mergedRawSym };
  for (const k of Object.keys(finalRawSym)) finalRawSym[k] += declaredSym[k] ?? 0;
  const augmentedDeclaredSym = { ...declaredSym };
  for (const g of symbolGlyphs) {
    finalRawSym[g]           = (finalRawSym[g]           ?? 0) + 1;
    augmentedDeclaredSym[g]  = (augmentedDeclaredSym[g]  ?? 0) + 1;
  }
  const netS = finalRawSym.s + finalRawSym.t;
  const netF = finalRawSym.f + finalRawSym.d;
  const finalResults = {
    totalSuccess:   netS,
    totalFailures:  netF,
    totalAdvantage: finalRawSym.a,
    totalThreat:    finalRawSym.h,
    totalTriumph:   finalRawSym.t,
    totalDespair:   finalRawSym.d,
    netSuccess:     netS - netF,
    netFailure:     netF - netS,
    netAdvantage:   finalRawSym.a - finalRawSym.h,
    netThreat:      finalRawSym.h - finalRawSym.a,
    faces:          mergedFaces,
    extraSymbols:   augmentedDeclaredSym,
  };
  let totalDamage   = weapon.systemData.baseDamage ?? 0;
  let damageFormula = String(weapon.systemData.baseDamage ?? 0);
  const damageChar  = weapon.systemData.damageCharacteristic;
  if (actor && damageChar && damageChar !== "-") {
    const cv = actor.system?.characteristics?.[damageChar] ?? 0;
    totalDamage += cv;
    const abbr = game.i18n.localize(`Genesys.CharacteristicAbbr.${damageChar.capitalize()}`);
    damageFormula = `${abbr} + ${damageFormula}`;
  }
  if (finalResults.netSuccess > 0) totalDamage += finalResults.netSuccess;

  const attackQualities = (weapon.systemData.qualities ?? []).map(q => ({ ...q }));
  await Promise.all(
    attackQualities.map(async q => {
      q.description = await TextEditor.enrichHTML(q.description ?? "", { async: true });
    })
  );

  let description = "";
  try {
    const doc = new DOMParser().parseFromString(data.content ?? "", "text/html");
    const el  = doc.querySelector(".roll-description");
    if (el) description = el.innerHTML;
  } catch {}

  let newContent;
  try {
    newContent = await renderTemplate(
      "systems/genesys/templates/chat/rolls/attack.hbs",
      {
        description,
        results:             finalResults,
        totalDamage,
        damageFormula,
        critical:            weapon.systemData.critical,
        qualities:           attackQualities.length === 0 ? undefined : attackQualities,
        showDamageOnFailure: CONFIG.genesys?.settings?.showAttackDetailsOnFailure ?? false,
      }
    );
  } catch (err) {
    console.error(`${MODULE_ID} | Template render failed:`, err);
    return data; 
  }

  console.log(`${MODULE_ID} | Applied quality mods for "${weapon.name}":`, enabledGlyphs.join(", "));
  return { ...data, content: newContent, rolls: allRolls };
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable Weapon Quality Dice",
    hint: "Automatically add dice from weapon qualities (e.g. Accurate 1 → +1 Boost) to attack rolls.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "customQualities", {
    name: "Custom Quality Map (JSON)",
    hint: 'Override or extend quality→dice mappings. Keys = quality names. '
        + 'Example: {"Guided":{"glyphs":["^"],"rated":false},"Unwieldy":{"glyphs":["S"],"rated":true}}. '
        + 'Glyphs: B=Boost S=Setback A=Ability P=Proficiency D=Difficulty C=Challenge '
        + '^=UpgradeAbility *=DowngradeAbility _=UpgradeDifficulty ~=DowngradeDifficulty',
    scope: "world",
    config: true,
    type: String,
    default: "{}",
  });

  console.log(`${MODULE_ID} | Registered settings`);
});

Hooks.on("renderDicePrompt", (app, html) => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  if (app.rollType !== 2) return;           
  const weapon = app.rollData?.weapon;
  if (!weapon) return;

  const { groups, allGlyphs } = getWeaponQualityGroups(weapon);
  _pendingAttack = null; 

  if (!groups.length) return;
  _pendingAttack = {
    weapon,
    actor:   app.actor,
    actorId: app.actor?.id ?? null,
    form:    app.form,        
    allGlyphs,
  };

  const container = html.find(".pool-modifications-container");
  if (!container.length) {
    console.warn(`${MODULE_ID} | Could not find .pool-modifications-container`);
    return; 
  }

  const rowsHtml = groups.map(buildQualityRow).join("");
  container.append(rowsHtml);
});

Hooks.on("closeApplication", (app) => {
  if (_pendingAttack && app.form === _pendingAttack.form) {
    _pendingAttack = null;
  }
});

Hooks.once("ready", () => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;

  const _origCreate = ChatMessage.create.bind(ChatMessage);

  ChatMessage.create = async function gwqCreate(data, options) {
    if (
      _pendingAttack &&
      Array.isArray(data?.rolls) &&
      data.rolls.length > 0 &&
      (!_pendingAttack.actorId || data?.speaker?.actor === _pendingAttack.actorId)
    ) {
      const pending = _pendingAttack;
      _pendingAttack = null; 

      try {
        data = await applyQualityModsToMessage(data, pending);
      } catch (err) {
        console.error(`${MODULE_ID} | Unexpected error applying quality mods:`, err);
      }
    }

    return _origCreate(data, options);
  };
  Object.defineProperty(ChatMessage.create, "name", { value: "create", configurable: true });
  console.log(`${MODULE_ID} | ChatMessage.create patched – weapon quality dice active`);
});
