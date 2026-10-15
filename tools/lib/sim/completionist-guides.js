'use strict';
// Completionist guides from a completionist route (docs/SIMULATION.md
// "Completionist", `sim export` of a completionist result): the simulator's
// executed steps (export.js executedSteps) as `category Completionist` guides
// that follow the guide conventions (docs/GUIDE_FORMAT.md):
//   - one guide per stretch of the route: zone visits in order, a short visit
//     (fewer than SHORT quest goals: a Stormwind stop, a lone turn-in) joins
//     the guide before it; a guide is named after its zones with the most goals;
//   - a step per place (consecutive goals within STEP_R yards), named after
//     the map area there, with `zone` where the zone changes;
//   - objectives as `kill` / `collect` / `interact` goals tied to the quest
//     (the world's tasks record which objectives they hold), `complete` for
//     events and escorts, `buy … nearest` for vendor items;
//   - an elite quest's goals all `optional`, with the step tip "<Target> is
//     elite: grouping up is advised."; a step left with optional goals only
//     joins the next step (or the one before at the end);
//   - profession quests whose giver is in the guide's zones: one player-facing
//     note in the last step (not routed: they need the skill);
//   - header comments: where the route comes from, the flow, the optional
//     elites, what is left to other guides (class, dungeon quests).
//
//   const guides = completionistGuides({ world, run, data, entries, meta, place, coverage, base, limit });
//   // [{ id, file, text, levels: [lo, hi], zones, quests, seconds }]

const { K_ACCEPT, K_TASK, K_TURNIN, K_DUNGEON } = require('./run');

const SHORT = 6; // quest goals: a visit with fewer joins the guide before it
const STEP_R = 150; // yards: consecutive goals this close share a step
const ELITE = new Set([1, 2, 3]);

function slug(s) {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The folder band of a guide starting at `level`: 1-20, then by tens.
function band(level) {
	if (level < 20) return '1-20';
	const lo = Math.min(50, Math.floor(level / 10) * 10);
	return `${lo}-${lo + 10}`;
}

// Elite targets of a quest (names): elite kill objectives, elite droppers of
// its objective items and of its starting item.
function eliteTargets(raw, data) {
	const names = [];
	const add = (npcId) => {
		const n = data.npcs[String(npcId)];
		if (n && ELITE.has(n.rank) && !n.faction && n.name && !names.includes(n.name)) names.push(String(n.name));
	};
	for (const o of (raw && raw.objectives) || []) {
		if (!o) continue;
		if (o.type === 'kill') add(o.id);
		else if (o.type === 'item') {
			const drops = (((data.items[String(o.id)] || {}).drops || {}).npc) || {};
			const ids = Object.keys(drops);
			// Only when no normal mob drops it too (the route used the elite).
			if (ids.length && ids.every((id) => ELITE.has((data.npcs[id] || {}).rank) || (data.npcs[id] || {}).faction)) ids.forEach(add);
		}
	}
	for (const item of ((raw && raw.start) || {}).item || []) for (const id of Object.keys((((data.items[String(item)] || {}).drops || {}).npc) || {})) add(id);
	return names;
}

// Goal lines for one executed step. -> [{ text, optional, elite: [names] }]
function goalsFor(e, ctx) {
	const { run, data } = ctx;
	const qi = run.qIndex.get(e.q);
	const wq = run.quests[qi];
	const raw = data.quests[String(e.q)] || {};
	const opt = wq.elite ? ' optional' : '';
	const elite = wq.elite ? eliteTargets(raw, data) : [];
	const out = [];
	const add = (text) => out.push({ text: `${text}${opt}`, optional: !!wq.elite, elite, q: e.q });
	if (e.kind === K_ACCEPT) {
		// A quest started by an item: loot it first (the item's droppers).
		const item = ((raw.start || {}).item || [])[0];
		if (wq.accept && item) add(`collect ${item} x1`);
		add(`accept ${e.q}`);
	} else if (e.kind === K_TURNIN) add(`turnin ${e.q}`);
	else if (e.kind === K_TASK) {
		// The task at this point (the hook passes the point, not the task).
		let task = null;
		for (let t = run.qTask0[qi]; t < run.qTask1[qi]; t++) if (run.taskPt[t] === e.pt) task = wq.tasks[t - run.qTask0[qi]];
		const objs = raw.objectives || [];
		const lines = [];
		const own = ctx.faction === 'Alliance' ? 'A' : 'H';
		let whole = !task || !task.objs || !task.objs.some((oi) => oi >= 0);
		const seen = new Set();
		(task ? task.objs : []).forEach((oi, wi) => {
			const o = objs[oi];
			if (oi < 0 || !o) {
				whole = true;
				return;
			}
			if (seen.has(oi)) return;
			seen.add(oi);
			const work = task.work[wi] || [];
			if (o.type === 'kill') {
				// Kill credit for a conversation or a deed on an NPC of the
				// character's side (work 'use'): the quest's own goal.
				const fac = String((data.npcs[String(o.id)] || {}).faction || '').toUpperCase();
				if (work[0] !== 'kill' || fac.includes(own)) whole = true;
				else lines.push(`kill ${o.id} quest ${e.q}.${oi + 1}`);
			} else if (o.type === 'item') {
				if (work[0] === 'buy') lines.push(`buy ${o.id} x${Number(o.count) > 0 ? o.count : 1} nearest`);
				else if (work[0] === 'kill' || (work[0] === 'use' && work[1] !== 1)) lines.push(`collect ${o.id} quest ${e.q}.${oi + 1}`);
				else whole = true; // handed over, or made on the spot
			} else if (o.type === 'object') lines.push(`interact ${o.id} quest ${e.q}.${oi + 1}`);
			else whole = true;
		});
		// `complete` holds its step until every objective is done: only at the
		// quest's last site (its other sites' kills and loot are goals of their own).
		const seenTasks = (ctx.taskSeen.get(e.q) || 0) + 1;
		ctx.taskSeen.set(e.q, seenTasks);
		const last = seenTasks >= run.qTask1[qi] - run.qTask0[qi];
		if (whole && last) add(`complete ${e.q}`);
		else for (const l of lines) add(l);
	}
	return out;
}

function completionistGuides({ world, run, data, entries, meta, place, coverage = null, base, limit = Infinity }) {
	const W = world.points;
	const ptOf = (e) => W[run.ptList[e.pt]];
	const zoneOf = (e) => world.zones[ptOf(e)[4]] || `map ${ptOf(e)[4]}`;
	const ctx = { run, data, faction: world.faction, taskSeen: new Map() };
	// Zone visits (dungeon runs never occur: the family has none).
	const visits = [];
	for (const e of entries) {
		if (e.type === 'step' && e.kind === K_DUNGEON) continue;
		const z = zoneOf(e);
		const last = visits[visits.length - 1];
		if (!last || (e.type === 'step' && last.zone !== z)) visits.push({ zone: z, entries: [e] });
		else last.entries.push(e);
	}
	const questGoals = (v) => v.entries.filter((e) => e.type === 'step' && (e.kind === K_ACCEPT || e.kind === K_TURNIN)).length;
	// Visits -> guides: a short visit joins the guide before it.
	const groups = [];
	for (const v of visits) {
		const g = groups[groups.length - 1];
		if (g && questGoals(v) < SHORT) g.visits.push(v);
		else groups.push({ visits: [v] });
	}
	const guides = [];
	const profByZone = new Map();
	for (const o of (coverage && coverage.out) || []) {
		if (o.reason !== 'profession') continue;
		if (!profByZone.has(o.zone)) profByZone.set(o.zone, []);
		profByZone.get(o.zone).push(o);
	}
	const outByZone = (reason) => {
		const m = new Map();
		for (const o of (coverage && coverage.out) || []) if (o.reason === reason) {
			if (!m.has(o.zone)) m.set(o.zone, []);
			m.get(o.zone).push(o);
		}
		return m;
	};
	const dungeonByZone = outByZone('dungeon');
	const profName = (raw) => {
		const p = data.professions && data.professions[String(raw.skill)];
		return p ? `${p.name}${raw.skillLevel ? ` ${raw.skillLevel}` : ''}` : 'a profession';
	};
	for (let gi = 0; gi < groups.length && gi < limit; gi++) {
		const entriesG = groups[gi].visits.flatMap((v) => v.entries);
		// Zones by goal count: the title's (top two) and the header zone.
		const count = new Map();
		for (const e of entriesG) if (e.type === 'step') count.set(zoneOf(e), (count.get(zoneOf(e)) || 0) + 1);
		const zonesByCount = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([z]) => z);
		const zonesInOrder = [...new Set(groups[gi].visits.map((v) => v.zone))];
		const titleZones = zonesInOrder.filter((z) => zonesByCount.slice(0, 2).includes(z) && count.get(z) >= SHORT);
		const title = (titleZones.length ? titleZones : [zonesByCount[0]]).join(' & ');
		const levels = entriesG.map((e) => e.level);
		const lo = Math.max(1, Math.floor(Math.min(...levels)));
		const hi = Math.max(lo, Math.min(60, Math.ceil(Math.max(...levels))));
		// Numbered to sort in route order (the menu lists a chain by id): as many digits as the whole route needs.
		const pad = Math.max(2, String(groups.length).length);
		guides.push({ gi, entries: entriesG, title, zone: zonesByCount[0], zones: zonesInOrder, lo, hi, id: `${base}/${String(gi + 1).padStart(pad, '0')}-${slug(title)}`, seconds: entriesG[entriesG.length - 1].time - entriesG[0].time, start: entriesG[0].time });
	}
	// Each guide's time runs to the next guide's start.
	for (let i = 0; i + 1 < guides.length; i++) guides[i].seconds = guides[i + 1].start - guides[i].start;
	return guides.map((g, i) => {
		// Steps.
		const steps = [];
		let cur = null;
		let zone = g.zone;
		const near = (a, b) => {
			const A = W[run.ptList[a]];
			const B = W[run.ptList[b]];
			return A[1] === B[1] && A[4] === B[4] && Math.hypot(A[2] - B[2], A[3] - B[3]) <= STEP_R;
		};
		const quests = new Set();
		const eliteQuests = new Map();
		for (const e of g.entries) {
			if (e.type !== 'step') {
				cur = null;
				if (e.type === 'fp') steps.push({ title: 'Flight path', goals: [{ text: `getfp "${e.name}"` }] });
				else if (e.type === 'bind') steps.push({ title: `Hearthstone: ${e.inn}`, goals: [{ text: `sethome "${e.inn}"` }] });
				else if (e.type === 'hearth') steps.push({ title: `Hearth to ${e.inn}`, goals: [{ text: `hearth "${e.inn}"` }] });
				else if (e.type === 'grind') {
					const to = Math.min(60, Math.floor(e.to + 1e-6));
					if (to > Math.floor(e.from)) steps.push({ title: `Level ${to}`, goals: [{ text: `level ${to}${e.spot ? ` -- grind on ${e.spot.mob} (level ${e.spot.level})${e.spot.area ? ` at ${e.spot.area}` : ''}` : ''}` }] });
				}
				continue;
			}
			const z = zoneOf(e);
			// A step per place and per kind of stop: quest givers and enders
			// (named after the first NPC) or objectives (named after the area).
			const talk = e.kind !== K_TASK;
			if (!cur || !near(cur.pt, e.pt) || cur.talk !== talk) {
				const wq = run.quests[run.qIndex.get(e.q)];
				const npc = e.kind === K_ACCEPT ? (wq.accept ? null : wq.gName) : e.kind === K_TURNIN ? wq.eName : null;
				const name = (talk && npc) || place(run.ptList[e.pt]) || z;
				cur = { title: name, pt: e.pt, talk, zone: z !== zone ? z : null, goals: [] };
				zone = z;
				steps.push(cur);
			}
			quests.add(e.q);
			for (const goal of goalsFor(e, ctx)) {
				if (cur.goals.some((x) => x.text === goal.text)) continue;
				cur.goals.push(goal);
				if (goal.elite && goal.elite.length) eliteQuests.set(goal.q, goal.elite);
			}
		}
		// A step of optional goals only is done at once: its goals join the
		// next step (the one before at the end).
		for (let s = 0; s < steps.length; s++) {
			const st = steps[s];
			if (!st.goals.length || st.goals.some((x) => !x.optional)) continue;
			const into = steps.slice(s + 1).find((x) => x.goals.length) || steps.slice(0, s).reverse().find((x) => x.goals.some((y) => !y.optional));
			if (!into) continue;
			const at = into === steps[s + 1] || steps.indexOf(into) > s ? 0 : into.goals.length;
			into.goals.splice(at, 0, ...st.goals);
			if (st.zone && !into.zone && steps.indexOf(into) > s) into.zone = st.zone;
			st.goals = [];
		}
		const kept = steps.filter((s) => s.goals.length);
		// Profession quests given in this guide's zones: a note in the last step.
		const prof = g.zones.flatMap((z) => profByZone.get(z) || []).filter((o) => !guides.slice(0, i).some((x) => x.zones.includes(o.zone)));
		if (prof.length && kept.length) {
			const list = prof.map((o) => `${o.title} (${profName(data.quests[String(o.id)] || {})})`).join(', ');
			kept[kept.length - 1].goals.push({ text: `note "Profession quests here, for players with the skill: ${list.replace(/"/g, "'")}."` });
		}
		// Text.
		const L = [
			`guide ${g.id}`,
			`title ${g.title}`,
			`faction ${meta.faction}`,
			`race ${meta.race}`,
			`levels ${g.lo}-${g.hi}`,
			`zone ${g.zone}`,
			'category Completionist',
			`folder Completionist · ${meta.race} ${band(guides[0] === g ? 1 : g.lo)}`,
			`keywords completionist, every quest${g.zones.length > 1 ? `, ${g.zones.join(', ')}` : ''}`,
		];
		if (i + 1 < guides.length) L.push(`next ${guides[i + 1].id}`);
		const elites = [...eliteQuests.entries()].map(([q, names]) => `${data.quests[String(q)] ? data.quests[String(q)].title : q} (${q}; ${names.join(', ')})`);
		const dungeons = g.zones.flatMap((z) => (dungeonByZone.get(z) || []).map((o) => `${o.title} (${o.id})`));
		const wrap = (text) => {
			const out = [];
			let line = '#';
			for (const w of text.split(' ')) {
				if (line.length + w.length + 1 > 78) {
					out.push(line);
					line = '#';
				}
				line += ` ${w}`;
			}
			if (line !== '#') out.push(line);
			return out;
		};
		L.push('');
		L.push(...wrap(`Route: ${meta.label}; guide ${i + 1} of ${guides.length}, levels ${g.lo} to ${g.hi}, ${quests.size} quests, ${(g.seconds / 3600).toFixed(1)} h under the model. Generated by \`polestar sim export\` from the completionist route (docs/SIMULATION.md "Completionist"); review in game before publishing.`));
		L.push('#');
		L.push(...wrap(`Flow: ${g.zones.join(' -> ')}.`));
		if (elites.length) {
			L.push('#');
			L.push(...wrap(`Optional (elite: grouping up is advised): ${elites.join('; ')}.`));
		}
		if (prof.length) {
			L.push('#');
			L.push(...wrap(`Profession quests here are not routed (they need the skill): ${prof.map((o) => `${o.id} ${o.title}`).join('; ')}.`));
		}
		L.push('#');
		L.push(...wrap(`Left to other guides: class quests (the Class category)${dungeons.length ? `; dungeon quests (the Dungeons guides): ${dungeons.join(', ')}` : ''}.`));
		for (const s of kept) {
			L.push('', `step ${s.title}`);
			if (s.zone) L.push(`  zone ${s.zone}`);
			const tips = [...new Set(s.goals.flatMap((x) => x.elite || []))];
			if (tips.length) L.push(`  tip ${tips.map((n) => `${n} is elite: grouping up is advised.`).join(' ')}`);
			for (const goal of s.goals) L.push(`  ${goal.text}`);
		}
		return { id: g.id, file: `${g.id}.guide`, text: `${L.join('\n')}\n`, levels: [g.lo, g.hi], zones: g.zones, quests: quests.size, seconds: g.seconds };
	});
}

module.exports = { completionistGuides, eliteTargets, band };
