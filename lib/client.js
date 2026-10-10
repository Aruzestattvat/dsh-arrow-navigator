window.__ModuleLoader__.load({
	id: "dsh-arrow-navigator",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region lib/types/client/options.js
		/**
		* Arrow-key navigation for the DSH Web client.
		*
		* Left/Right move between Conversations (Sessions) in the same order the
		* sidebar shows them; Up/Down move between the Turns (对话段) of the current
		* Conversation. Bare arrow keys are reserved keys in the shortcut registry,
		* so they can never be bound as editable commands; the feature therefore
		* declares them through `registerFixed` (reference + conflict protection) and
		* receives them through `observeFixedInput`, which is the sanctioned channel
		* for plain, non-modifier input.
		*
		* Runtime knobs live in `localStorage["dsh.arrow-nav.v1"]` as a JSON object:
		* `{ "hint": boolean, "wrap": boolean, "loadEarlier": boolean,
		*    "allowEmptyComposer": boolean }`.
		*/
		const OPTIONS_KEY = "dsh.arrow-nav.v1";
		/**
		* Runtime knobs.
		*
		* `autoCollapse` is off by default: an expansion this navigation performed stays
		* open, which is the behaviour the feature shipped with first. Turning it on
		* folds such a group back as soon as the reader leaves it. `diagnostics` is off
		* by default as well: the panel is a support tool, so it never appears unasked —
		* `Shift+↑` still summons it, and setting the knob to `true` lets it explain
		* refusals and skips by itself. `autoHideMs` is how long such a panel then stays.
		*/
		const DEFAULT_OPTIONS = Object.freeze({
			hint: true,
			wrap: false,
			loadEarlier: true,
			allowEmptyComposer: true,
			autoExpand: true,
			autoCollapse: false,
			diagnostics: false,
			autoHideMs: 6000,
			holdRepeat: true,
			holdPreview: false,
			holdTurns: false
		});
		/**
		* Build marker.
		*
		* The client module system can keep serving a previously published bundle
		* (a page that never reloaded, a revision the page failed to materialize), so
		* every diagnostic line and every "end of list" hint carries this marker: a
		* report then names the build it came from instead of leaving it ambiguous.
		*/
		const BUILD = "1.8.1";
		/**
		* Read the runtime knobs, ignoring malformed or partial stored documents.
		* @returns a complete options object.
		*/
		function readOptions() {
			const options = { ...DEFAULT_OPTIONS };
			try {
				const raw = window.localStorage === undefined ? null : window.localStorage.getItem(OPTIONS_KEY);
				if (typeof raw === "string" && raw !== "") {
					const stored = JSON.parse(raw);
					if (stored !== null && typeof stored === "object") for (const key of Object.keys(DEFAULT_OPTIONS)) {
						const value = stored[key];
						// Booleans are switches; `autoHideMs` is the one duration.
						if (typeof DEFAULT_OPTIONS[key] === "number") {
							if (typeof value === "number" && Number.isFinite(value) && value >= 0) options[key] = value;
							continue;
						}
						if (typeof value === "boolean") options[key] = value;
					}
				}
			} catch (_error) {}
			return options;
		}
		//#endregion
		//#region lib/types/client/sessions.js
		/** Minimum time a "load earlier" page is awaited before navigation gives up. */
		const LOAD_TIMEOUT_MS = 4000;
		/** Interval between two checks for newly paged-in history. */
		const LOAD_POLL_MS = 80;
		/**
		* Mirror the sidebar's row visibility rule: subagent children never take a
		* row, only the current Session may be blank, and archived rows follow the
		* default filter.
		* @param session - one `sessions.list` row.
		* @param current - the Session retained by the main view, when known.
		* @param archived - archived Session ids.
		* @returns whether the row occupies a sidebar slot.
		*/
		function sessionVisible(session, current, archived) {
			if (session === undefined) return false;
			if (session.origin === "subagent") return false;
			if (session.blank && session.id !== current) return false;
			return !archived.has(session.id);
		}
		/**
		* Keep the current blank placeholder first, then pinned rows, then the
		* caller's order — the same partition the sidebar applies inside a group.
		* @param members - visible rows in caller order.
		* @param pinned - pinned Session ids.
		* @param archived - archived Session ids.
		* @returns reordered rows.
		*/
		function sectionMembers(members, pinned, archived) {
			const placeholders = [];
			const leading = [];
			const rest = [];
			for (const member of members) {
				if (member.blank) placeholders.push(member);
				else if (!archived.has(member.id) && pinned.has(member.id)) leading.push(member);
				else rest.push(member);
			}
			return [
				...placeholders,
				...leading,
				...rest
			];
		}
		/**
		* The largest visible Conversation occurrence, used as the current Session
		* when the retention projection has not settled yet.
		* @param doc - product document.
		* @returns a Session id, or undefined.
		*/
		function domSessionId(doc) {
			let best;
			let bestArea = 0;
			for (const node of doc.querySelectorAll("[data-conversation-session]")) {
				const id = node.dataset === undefined ? undefined : node.dataset.conversationSession;
				if (typeof id !== "string" || id === "") continue;
				const rect = node.getBoundingClientRect();
				const area = rect.width * rect.height;
				if (area <= bestArea) continue;
				best = id;
				bestArea = area;
			}
			return best;
		}
		/**
		* The sidebar's rows and expand affordances, in the order they are rendered.
		*
		* Reading the rendered rows is what makes arrow navigation "in order": the
		* sidebar renders one row per visible Session, so it already carries group
		* order, the pinned-first partition, the collapsed-group state, the
		* "expand the remaining N sessions" state, and search results. Rows that are
		* not laid out (a hidden or railed sidebar) are skipped so the service
		* projection takes over instead of navigating invisible rows.
		*
		* Two affordances hide Sessions from the rendered list, both keyed by the
		* sidebar's own `data-row-key`:
		* - `overflow:<groupKey>` — the "expand the remaining N sessions" button; each
		*   press reveals one batch (5 rows), the final press reveals the rest, and the
		*   button then turns into the group's collapse control.
		* - `workspace:<groupKey>` with `aria-expanded="false"` — a collapsed group
		*   header, whose click toggles the group.
		* @param doc - product document.
		* @param list - `sessions.list` snapshot.
		* @returns ordered entries (`session` rows and `expand` affordances).
		*/
		function sidebarEntries(doc, list) {
			const entries = [];
			const seen = new Set();
			let group;
			for (const node of doc.querySelectorAll("[data-row-key]")) {
				const key = node.dataset === undefined ? undefined : node.dataset.rowKey;
				if (typeof key !== "string") continue;
				const rect = node.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) continue;
				if (key.startsWith("session:")) {
					const id = key.slice(8);
					if (id === "" || seen.has(id) || list.byId[id] === undefined) continue;
					seen.add(id);
					entries.push({
						kind: "session",
						id,
						node,
						group,
						selected: node.getAttribute("aria-selected") === "true"
					});
					continue;
				}
				if (key.startsWith("overflow:")) {
					// A fully revealed group keeps this button as its collapse control;
					// treating that state as an expand affordance would flip the group
					// back and forth instead of moving the reader.
					if (node.getAttribute("aria-expanded") !== "true") entries.push({
						kind: "expand",
						variant: "overflow",
						key,
						group: key.slice(9),
						node
					});
					continue;
				}
				if (key.startsWith("workspace:")) {
					group = key.slice(10);
					if (node.getAttribute("aria-expanded") === "false") entries.push({
						kind: "expand",
						variant: "collapsed",
						key,
						group,
						node
					});
				}
			}
			return entries;
		}
		/**
		* The rendered Session rows, in sidebar order.
		* @param doc - product document.
		* @param list - `sessions.list` snapshot.
		* @returns `{ id, selected, node }` rows in DOM order.
		*/
		function domSessionRows(doc, list) {
			return sidebarEntries(doc, list).filter((entry) => entry.kind === "session");
		}
		/** Session ids are opaque and long; diagnostics only need to tell them apart. */
		function shortId(id) {
			if (typeof id !== "string") return String(id ?? "-");
			return (id.startsWith("session-") ? id.slice(8) : id).slice(0, 8);
		}
		/**
		* Resolve after the browser had a chance to commit the click's re-render. */
		function nextPaint() {
			return new Promise((resolve) => {
				if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => {
					window.setTimeout(resolve, 0);
				});
				else window.setTimeout(resolve, 0);
			});
		}
		/**
		* Click one affordance until the rows it hides are rendered.
		*
		* An overflow button is pressed repeatedly (each press reveals one batch and
		* the last one removes the button), a collapsed header only once. Every press
		* is a plain user-equivalent click, so the sidebar's own state does the work —
		* nothing here reaches into component state.
		* @param entry - the expand entry to drive.
		* @returns whether the affordance stopped hiding rows.
		*/
		async function revealSidebar(entry) {
			for (let press = 0; press < 12; press += 1) {
				const node = entry.node;
				if (node === null || node.isConnected === false) return true;
				node.click();
				await nextPaint();
				if (node.isConnected === false) return true;
				if (entry.variant === "collapsed") return node.getAttribute("aria-expanded") === "true";
				if (node.getAttribute("aria-expanded") === "true") return true;
			}
			return false;
		}
		/**
		* Scroll one sidebar row into view without moving anything else.
		* @param doc - product document.
		* @param list - `sessions.list` snapshot.
		* @param id - the Session whose row should be revealed.
		*/
		function revealRow(doc, list, id) {
			for (const entry of domSessionRows(doc, list)) {
				if (entry.id !== id) continue;
				if (typeof entry.node.scrollIntoView !== "function") return;
				try {
					entry.node.scrollIntoView({ block: "nearest" });
				} catch (_error) {}
				return;
			}
		}
		/**
		* One sidebar row by its exact `data-row-key`.
		* @param doc - product document.
		* @param key - the row key to find.
		* @returns the element, or null.
		*/
		function sidebarRowByKey(doc, key) {
			for (const node of doc.querySelectorAll("[data-row-key]")) {
				if (node.dataset !== undefined && node.dataset.rowKey === key) return node;
			}
			return null;
		}
		/**
		* The group a rendered Session row belongs to.
		* @param doc - product document.
		* @param list - `sessions.list` snapshot.
		* @param id - Session id.
		* @returns the group key, or undefined when the row is not rendered.
		*/
		function groupOfSession(doc, list, id) {
			for (const entry of sidebarEntries(doc, list)) {
				if (entry.kind === "session" && entry.id === id) return entry.group;
			}
			return undefined;
		}
		/**
		* Undo the expansions this navigation performed.
		*
		* Every expansion is remembered per group and unwound through the sidebar's own
		* control, so the result is exactly what a person gets by clicking it: a
		* collapsed header is toggled back, and a fully expanded group is pressed
		* through its "collapse" button (which returns that group to its default row
		* batch). The group the reader stays in keeps its expansion.
		* @param doc - product document.
		* @param expansions - remembered expansions, keyed by group.
		* @param keep - the group key to leave expanded.
		*/
		function collapseExpansions(doc, expansions, keep) {
			for (const [group, entry] of [...expansions]) {
				if (group === keep) continue;
				const control = sidebarRowByKey(doc, entry.key);
				if (control === null) {
					// the affordance is gone, so there is nothing left to unwind
					expansions.delete(group);
					continue;
				}
				// A partially revealed group has no collapse control yet; keep it
				// tracked so a later step can still unwind it.
				if (control.getAttribute("aria-expanded") !== "true") continue;
				expansions.delete(group);
				control.click();
			}
		}
		/**
		* Resolve the Session shown in the main panel.
		*
		* The rendered Conversation is authoritative: it is literally the Session on
		* screen, and a retention projection that lags behind it would make every step
		* compute the same "next" neighbour and open a Session the view already shows —
		* a press that looks like nothing happened. Retention stands in while no
		* Conversation is mounted (a fresh or blank Session), then the sidebar's own
		* selection, then the widest occurrence.
		* @param list - `sessions.list` snapshot.
		* @param doc - product document.
		* @returns a Session id, or undefined when no Conversation is open.
		*/
		function currentSessionId(list, doc) {
			for (const scope of conversationScopes(doc)) {
				for (const node of scope.querySelectorAll("[data-conversation-session]")) {
					const id = node.dataset === undefined ? undefined : node.dataset.conversationSession;
					if (typeof id !== "string" || id === "" || list.byId[id] === undefined) continue;
					const rect = node.getBoundingClientRect();
					if (rect.width <= 0 || rect.height <= 0) continue;
					return id;
				}
			}
			for (const id of list.ids) {
				const row = list.byId[id];
				if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id;
			}
			for (const row of Object.values(list.byId)) if ((row.retainedBy?.mainView ?? 0) > 0) return row.id;
			for (const row of domSessionRows(doc, list)) if (row.selected) return row.id;
			const fromDom = domSessionId(doc);
			return fromDom !== undefined && list.byId[fromDom] !== undefined ? fromDom : undefined;
		}
		/**
		* Project the visible conversations in sidebar order.
		*
		* Rendered sidebar rows win, because they are the order the user is looking
		* at. The service projection stands in when the sidebar is not rendered: the
		* grouped sidebar resolves members from `workspace.sessionIds` and trails
		* unaccounted Sessions, the flat list uses `list.ids`, and both apply the same
		* visibility filter and blank/pinned partition the sidebar itself applies.
		* @param list - `sessions.list` snapshot.
		* @param workspaces - `workspaces.list` snapshot, when available.
		* @param doc - product document.
		* @returns ordered Session ids plus the resolved current id.
		*/
		function orderedSessions(list, workspaces, doc) {
			const archived = new Set(workspaces?.archivedSessionIds ?? []);
			const current = currentSessionId(list, doc);
			const rendered = domSessionRows(doc, list).filter((row) => sessionVisible(list.byId[row.id], current, archived));
			if (rendered.length >= 1) return {
				ids: rendered.map((row) => row.id),
				byId: list.byId,
				current
			};
			return {
				ids: projectSessionOrder(list, workspaces, current),
				byId: list.byId,
				current
			};
		}
		/**
		* The Session order the sidebar is built from, without reading the DOM.
		*
		* The grouped sidebar resolves members from `workspace.sessionIds` and trails
		* unaccounted Sessions; the flat list uses `list.ids`. Both apply the same
		* visibility filter and blank/pinned partition the sidebar itself applies.
		* @param list - `sessions.list` snapshot.
		* @param workspaces - `workspaces.list` snapshot, when available.
		* @param current - the Session retained by the main view.
		* @returns visible Session ids in projection order.
		*/
		function projectSessionOrder(list, workspaces, current) {
			const archived = new Set(workspaces?.archivedSessionIds ?? []);
			const pinned = new Set(workspaces?.pinnedSessionIds ?? []);
			const groups = [];
			const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
			if (items.length > 0) {
				const accounted = new Set();
				for (const workspace of items) {
					const members = [];
					for (const id of workspace.sessionIds ?? []) {
						const row = list.byId[id];
						if (row === undefined) continue;
						accounted.add(id);
						if (sessionVisible(row, current, archived)) members.push(row);
					}
					if (members.length > 0) groups.push(sectionMembers(members, pinned, archived));
				}
				const stray = [];
				for (const id of list.ids) {
					const row = list.byId[id];
					if (row === undefined || accounted.has(id) || !sessionVisible(row, current, archived)) continue;
					stray.push(row);
				}
				if (stray.length > 0) groups.push(sectionMembers(stray, pinned, archived));
			} else {
				const flat = [];
				for (const id of list.ids) {
					const row = list.byId[id];
					if (row !== undefined && sessionVisible(row, current, archived)) flat.push(row);
				}
				groups.push(sectionMembers(flat, pinned, archived));
			}
			return groups.flat().map((row) => row.id);
		}
		/**
		* The workspace group a Session belongs to, from the service projection.
		* @param workspaces - `workspaces.list` snapshot, when available.
		* @param sessionId - Session id.
		* @returns the group key, or undefined when nothing knows the Session.
		*/
		function groupOfSessionService(workspaces, sessionId) {
			const items = Array.isArray(workspaces?.items) ? workspaces.items : [];
			if (items.length === 0) return undefined;
			for (const workspace of items) {
				if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace.workspaceId;
			}
			// Sessions no Workspace accounts for trail in the ungrouped group.
			return "";
		}
		/**
		* The sidebar control that currently hides one Session's group.
		* @param doc - product document.
		* @param list - `sessions.list` snapshot.
		* @param workspaces - `workspaces.list` snapshot, when available.
		* @param sessionId - the Session that has to become visible.
		* @returns the expand entry, or null when nothing hides it.
		*/
		function groupAffordance(doc, list, workspaces, sessionId) {
			const group = groupOfSessionService(workspaces, sessionId);
			if (group === undefined) return null;
			for (const entry of sidebarEntries(doc, list)) {
				if (entry.kind === "expand" && entry.group === group) return entry;
			}
			return null;
		}
		/**
		* Read the rendered sidebar one hop at a time.
		*
		* The rows the sidebar hides sit between two rendered rows, so the deciding
		* question for a step is what comes *first* in the direction of travel: another
		* Session row, or the affordance that hides the next one. Taking the first hop
		* is what keeps hidden Sessions in order — stepping from the last revealed row
		* of a group must reach the group's next hidden Session, not the next group.
		* @param entries - ordered sidebar entries (Session rows and affordances).
		* @param at - index of the current Session row.
		* @param delta - -1 for the previous conversation, +1 for the next.
		* @param allowExpand - whether an affordance may be driven.
		* @returns `{ id }`, `{ expand }`, or `{ blocked }`.
		*/
		function firstHop(entries, at, delta, allowExpand) {
			for (let index = at + delta; index >= 0 && index < entries.length; index += delta) {
				const entry = entries[index];
				if (entry.kind === "session") return { id: entry.id };
				if (allowExpand) return { expand: entry };
			}
			return { blocked: delta > 0 ? "last" : "first" };
		}
		/**
		* Plan one conversation step.
		*
		* The plan is decided synchronously so a key press can be consumed in the same
		* tick, and it distinguishes three outcomes: open a Session, report a blocked
		* end, or expand a sidebar affordance and plan again afterwards.
		* @param ctx - client plugin context.
		* @param delta - -1 for the previous conversation, +1 for the next.
		* @param options - runtime knobs.
		* @param skipped - Sessions whose open failed; the step walks past them.
		* @param from - Session to walk from (a held key walks from its cursor).
		* @returns `{ id, index, total, title }`, `{ blocked }`, `{ expand }`, or null.
		*/
		function planSessionStep(ctx, delta, options, skipped = new Set(), from = undefined) {
			const list = ctx.sessions.list.getSnapshot();
			if (list.phase !== "ready" || list.ids.length === 0) return { trace: `s:phase=${list.phase} ids=${list.ids.length}` };
			const doc = window.document;
			const workspaces = ctx.get("workspaces")?.list?.getSnapshot?.();
			const archived = new Set(workspaces?.archivedSessionIds ?? []);
			const current = from ?? currentSessionId(list, doc);
			const visible = (id) => sessionVisible(list.byId[id], current, archived) && !skipped.has(id);
			// Rendered sidebar: walk its own rows, so a hidden region between two rows
			// is crossed by revealing it rather than by jumping over it.
			const entries = sidebarEntries(doc, list).filter((entry) => entry.kind === "expand" || visible(entry.id));
			const at = entries.findIndex((entry) => entry.kind === "session" && entry.id === current);
			const stamp = `vis=${entries.filter((entry) => entry.kind === "session").length} at=${at} cur=${shortId(current)}${skipped.size === 0 ? "" : ` skip=${skipped.size}`}`;
			if (at !== -1) {
				const hop = firstHop(entries, at, delta, options.autoExpand);
				if (hop.expand !== undefined) return {
					expand: hop.expand,
					trace: `${stamp} hop=expand(${hop.expand.key})`
				};
				if (hop.id !== undefined) return sessionPlan(ctx, list, workspaces, doc, hop.id, current, `${stamp} hop=row`);
				// An explicit opt-out keeps navigation inside the rendered list.
				if (!options.autoExpand) return {
					blocked: hop.blocked,
					trace: `${stamp} hop=end(autoExpand off)`
				};
			}
			// The rendered sidebar cannot decide this step: its rows ran out while the
			// projection still knows more Sessions, or the Session being read is itself
			// hidden. Follow the projection instead of stalling, and drive the control
			// that hides the target when the sidebar exposes one.
			const ids = projectSessionOrder(list, workspaces, current).filter((id) => !skipped.has(id));
			if (ids.length === 0) return { trace: `${stamp} proj=0` };
			const index = current === undefined ? -1 : ids.indexOf(current);
			let next = index === -1 ? delta > 0 ? 0 : ids.length - 1 : index + delta;
			const projected = `${stamp} proj=${ids.length} idx=${index}`;
			if (next < 0) {
				if (!options.wrap) return {
					blocked: "first",
					trace: `${projected} end`
				};
				next = ids.length - 1;
			}
			if (next >= ids.length) {
				if (!options.wrap) return {
					blocked: "last",
					trace: `${projected} end`
				};
				next = 0;
			}
			const target = ids[next];
			if (target === undefined || target === current) return { trace: `${projected} noTarget` };
			if (options.autoExpand) {
				const affordance = groupAffordance(doc, list, workspaces, target);
				if (affordance !== null) return {
					expand: affordance,
					trace: `${projected} reveal(${affordance.key})`
				};
			}
			return sessionPlan(ctx, list, workspaces, doc, target, current, `${projected} take`);
		}
		/**
		* Build the payload for one target Session.
		* @param ctx - client plugin context.
		* @param list - `sessions.list` snapshot.
		* @param workspaces - `workspaces.list` snapshot, when available.
		* @param doc - product document.
		* @param target - the Session to open.
		* @param current - the Session the step starts from.
		* @param trace - how this target was chosen, for the diagnostics overlay.
		* @returns the plan, or null when the target is the current Session.
		*/
		function sessionPlan(ctx, list, workspaces, doc, target, current, trace = "") {
			if (target === current) return { trace: `${trace} target=current` };
			// Report the position in the list the reader is looking at when the target
			// is rendered there, and in the projection otherwise (a revealed row).
			const rendered = domSessionRows(doc, list).map((row) => row.id);
			const at = rendered.indexOf(target);
			const ids = at === -1 ? projectSessionOrder(list, workspaces, current) : rendered;
			const row = list.byId[target];
			const title = row === undefined ? undefined : row.title ?? row.displayTitle;
			return {
				id: target,
				index: Math.max(1, (at === -1 ? ids.indexOf(target) : at) + 1),
				total: Math.max(ids.length, 1),
				title: typeof title === "string" && title !== "" ? title : target,
				trace: `${trace} open=${shortId(target)}(${String(at === -1 ? ids.indexOf(target) : at) + 1}/${ids.length})`
			};
		}
		/**
		* Whether the client already retains one Session as the main view.
		*
		* `retainInfo` is the live per-Session retention observable, so this answers
		* synchronously right after `openSession` — no frame has to pass for a healthy
		* open to be recognised.
		* @param ctx - client plugin context.
		* @param id - Session to test.
		* @returns whether the main view retains it.
		*/
		function retainedAsMain(ctx, id) {
			try {
				const info = ctx.sessions.retainInfo(id)?.getSnapshot?.();
				if ((info?.retainedBy?.mainView ?? 0) > 0) return true;
			} catch (_error) {}
			const row = ctx.sessions.list.getSnapshot().byId[id];
			return (row?.retainedBy?.mainView ?? 0) > 0;
		}
		/**
		* Wait for an opened Session to actually become the visible Conversation.
		*
		* `openSession` can complete without the main view moving (an open the Host
		* never confirms). Verifying inside the same press turns that silent failure
		* into an ordinary skip instead of a press that looks dead.
		* @param ctx - client plugin context.
		* @param id - the Session that was opened.
		* @param timeoutMs - how long to wait for the view to adopt it.
		* @returns whether the Session became current.
		*/
		async function openedTook(ctx, id, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (retainedAsMain(ctx, id) || currentSessionId(ctx.sessions.list.getSnapshot(), window.document) === id) return true;
				if (Date.now() >= deadline) return false;
				await new Promise((resolve) => {
					window.setTimeout(resolve, OPEN_POLL_MS);
				});
			}
		}
		/**
		* Open the Session a plan selected and keep its sidebar row visible.
		*
		* `openSession` retains the Session synchronously, so an unopenable one throws
		* here instead of failing later: the caller turns that into a skip.
		* @param ctx - client plugin context.
		* @param plan - a plan carrying the target Session.
		* @returns whether the Session was opened.
		*/
		function openSessionStep(ctx, plan) {
			const uiWorkspace = ctx.get("uiWorkspace");
			if (uiWorkspace === undefined) throw new Error("uiWorkspace service is unavailable");
			if (typeof plan.id !== "string" || plan.id === "") throw new Error("plan carries no Session id");
			uiWorkspace.openSession(plan.id);
			revealRow(window.document, ctx.sessions.list.getSnapshot(), plan.id);
			return true;
		}
		//#endregion
		//#region lib/types/client/conversation.js
		/** Alignment of a jumped-to Turn below the scrollport's top edge (matches Chat). */
		const TURN_INSET_PX = 24;
		/** Reading line cap used by the app's own active-Turn resolution. */
		const READING_LINE_MAX_PX = 96;
		/** Corrections applied while the app's follow-tail policy settles. */
		const SETTLE_FRAMES = 4;
		/** Expansion rounds a single conversation step may spend on sidebar affordances. */
		const MAX_EXPAND_ROUNDS = 8;
		/** Unopenable Sessions one step may walk past before reporting the end. */
		const MAX_SKIP_ROUNDS = 12;
		/** How long an opened Session has to become the visible Conversation. */
		const OPEN_SETTLE_MS = 350;
		/** Interval between two checks for that adoption. */
		const OPEN_POLL_MS = 25;
		/** Delay before a held arrow key starts repeating. */
		const HOLD_DELAY_MS = 220;
		/** Interval between two steps while an arrow key is held. */
		const HOLD_STEP_MS = 90;
		/** Most steps one hold may take, so a lost keyup cannot run away. */
		const HOLD_MAX_STEPS = 80;
		/** Marks the sidebar row a held arrow key would open on release. */
		const CURSOR_ATTRIBUTE = "data-arrow-nav-cursor";
		/** Highlight for that row: the reader's place in a held walk. */
		const CURSOR_CSS = `[${CURSOR_ATTRIBUTE}="true"]{outline:2px solid var(--dsw-alias-state-business-primary,#6ea8fe);outline-offset:-2px;border-radius:8px}`;
		/** Localized labels of the transcript's history button, including its busy state. */
		const LOAD_EARLIER_LABELS = new Set([
			"加载更早",
			"加载中",
			"加载中…",
			"Load earlier",
			"Loading",
			"Loading…"
		]);
		/** Largest-area element of a node list, or null. */
		function largest(nodes) {
			let best = null;
			let bestArea = 0;
			for (const node of nodes) {
				const rect = node.getBoundingClientRect();
				const area = rect.width * rect.height;
				if (area <= bestArea) continue;
				best = node;
				bestArea = area;
			}
			return best;
		}
		/** The element that carries the Conversation transcript. */
		const SCROLL_SELECTOR = "[data-conversation-scroll]";
		/** The resident composer whose empty editor may release its arrows. */
		const COMPOSER_SELECTOR = "[data-conversation-region=\"composer\"], [data-slot=\"conversation.composer.bar\"], [data-composer-seat]";
		/**
		* Whether the focused element shares a column with a Conversation transcript.
		*
		* Chat renders the composer BESIDE the transcript rather than inside it, and it
		* focuses that editor after every switch, so "inside the conversation" cannot
		* mean "inside the transcript". Walking up from the target asks the useful
		* question directly — does this focus live in a container that holds a
		* transcript? — without guessing which transcript is the main one.
		* @param target - focused element.
		* @returns whether the target sits in a conversation column.
		*/
		function inMainColumn(target) {
			const doc = window.document;
			let node = target.parentElement;
			for (let depth = 0; node !== null && node !== undefined && node !== doc.body && node !== doc.documentElement && depth < 6; depth += 1) {
				if (node.querySelector(SCROLL_SELECTOR) !== null) return true;
				node = node.parentElement;
			}
			return false;
		}
		/**
		* Resolve the elements that constitute the main Conversation seat.
		*
		* The declarative slot marker is authoritative; when a composition renders
		* the Conversation without one, the largest visible occurrence stands in. The
		* composer belongs to the same column but sits BESIDE the transcript rather than
		* inside it, so it is a scope of its own: after a switch Chat focuses its editor,
		* and refusing that focus would leave the arrows dead right when they are wanted.
		* @param doc - product document.
		* @returns scope elements (possibly empty).
		*/
		function conversationScopes(doc) {
			const scopes = [];
			const slot = doc.querySelector("[data-slot=\"main.conversation\"]");
			if (slot !== null) scopes.push(slot);
			else {
				const occurrence = largest(doc.querySelectorAll("[data-conversation-session]"));
				if (occurrence !== null) scopes.push(occurrence);
			}
			for (const node of doc.querySelectorAll(COMPOSER_SELECTOR)) scopes.push(node);
			return scopes;
		}
		/**
		* Resolve the sidebar seats that may also drive conversation switching.
		* @param doc - product document.
		* @returns scope elements (possibly empty).
		*/
		function sidebarScopes(doc) {
			const scopes = [];
			for (const name of [
				"sidebar",
				"sidebar.workspaces",
				"sidebar.browser"
			]) {
				const node = doc.querySelector(`[data-slot="${name}"]`);
				if (node !== null) scopes.push(node);
			}
			return scopes;
		}
		/**
		* Resolve the main Conversation scrollport: the marker inside the main seat
		* when present, otherwise the largest visible scrollport.
		* @param doc - product document.
		* @returns the scrollport element, or null.
		*/
		function scrollerFor(doc) {
			for (const scope of conversationScopes(doc)) {
				const inner = largest(scope.querySelectorAll("[data-conversation-scroll]"));
				if (inner !== null) return inner;
			}
			return largest(doc.querySelectorAll("[data-conversation-scroll]"));
		}
		/**
		* Collect the loaded Turn rows in DOM order.
		*
		* One Turn owns several rows (its nodes and process groups), so callers that
		* need a Turn's start take the first row carrying its number. Rows that are
		* not laid out — inside a collapsed process group, or an empty flow item —
		* carry no usable geometry and are skipped.
		* @param scroller - Conversation scrollport.
		* @returns `{ row, turn }` entries with a safe-integer Turn number.
		*/
		function turnRows(scroller) {
			const rows = [];
			for (const row of scroller.querySelectorAll("[data-chat-turn]")) {
				if (row.hidden === true) continue;
				const value = row.dataset === undefined ? undefined : row.dataset.chatTurn;
				const turn = Number(value);
				if (!Number.isSafeInteger(turn)) continue;
				if (row.getBoundingClientRect().height <= 0) continue;
				rows.push({ row, turn });
			}
			return rows;
		}
		/**
		* The transcript's own Turn navigation rail, when it renders one.
		*
		* Chat ships a rail of one mark per Turn beside the transcript; its marks are
		* real buttons carrying `data-index` (their position in the merged outline and
		* loaded ladder) and the active mark carries `aria-current`. Driving those
		* marks is how a person navigates Turns, so the jump inherits Chat's own
		* paging, follow-pausing and landing logic instead of racing it.
		* @param doc - product document.
		* @param scroller - Conversation scrollport.
		* @returns the sibling marks plus the active one, or null without a rail.
		*/
		function turnRail(doc, scroller) {
			for (const scope of [scroller, ...conversationScopes(doc)]) {
				const buttons = [...scope.querySelectorAll("button[data-index]")];
				const active = buttons.find((button) => button.getAttribute("aria-current") === "true");
				if (active === undefined) continue;
				const container = active.parentElement;
				if (container === null) continue;
				const marks = buttons.filter((button) => button.parentElement === container);
				if (marks.length < 2) continue;
				const index = Number(active.dataset === undefined ? undefined : active.dataset.index);
				if (!Number.isSafeInteger(index)) continue;
				return { marks, index };
			}
			return null;
		}
		/**
		* Jump one Turn by pressing the rail's neighbouring mark.
		* @param doc - product document.
		* @param scroller - Conversation scrollport.
		* @param delta - -1 for the previous Turn, +1 for the next.
		* @returns a hint payload, or null when the rail cannot take this step.
		*/
		function stepTurnByRail(doc, scroller, delta) {
			const rail = turnRail(doc, scroller);
			if (rail === null) return null;
			const target = rail.marks.find((mark) => Number(mark.dataset === undefined ? undefined : mark.dataset.index) === rail.index + delta);
			// A mark outside the rail's virtual window has no button to press.
			if (target === undefined) return null;
			const label = target.getAttribute("aria-label") ?? "";
			const turn = Number((/\d+/u.exec(label) ?? [])[0]);
			target.click();
			return {
				railTurn: Number.isSafeInteger(turn) ? turn : undefined,
				trace: `rail ${String(rail.index)}→${String(rail.index + delta)}`
			};
		}
		/**
		* Resolve the Turn sitting at the reading line.
		* @param scroller - Conversation scrollport.
		* @param rows - Turn anchors in DOM order.
		* @returns the `{ row, turn }` entry read as current.
		*/
		function readingEntry(scroller, rows) {
			const viewport = scroller.getBoundingClientRect();
			const line = viewport.top + Math.min(READING_LINE_MAX_PX, scroller.clientHeight * 0.2);
			let reading = rows[0];
			for (const entry of rows) {
				if (entry.row.getBoundingClientRect().top <= line) reading = entry;
				else break;
			}
			return reading;
		}
		/**
		* The Turn a key press acts from.
		*
		* A jump remembers where it landed, exactly like the Chat viewport's own
		* landing does: while the scrollport has not moved since, that Turn stays
		* current instead of being re-derived from geometry. Re-derivation alone is
		* what made Up stick — an aligned Turn is frequently shorter than the reading
		* line, so the geometry reads the *next* Turn and the following Up press
		* targets the row it just left.
		* @param scroller - Conversation scrollport.
		* @param rows - Turn rows in DOM order.
		* @param state - per-Conversation reading memory.
		* @returns the current Turn number.
		*/
		function readTurn(scroller, rows, state) {
			if (state.turn !== null && Math.abs(scroller.scrollTop - state.top) <= 1) return state.turn;
			return readingEntry(scroller, rows).turn;
		}
		/**
		* Compute the scroll offset that aligns a Turn below the scrollport's top.
		* @param scroller - Conversation scrollport.
		* @param row - Turn anchor to align.
		* @returns a clamped scroll offset.
		*/
		function offsetFor(scroller, row) {
			const viewport = scroller.getBoundingClientRect();
			const target = scroller.scrollTop + (row.getBoundingClientRect().top - viewport.top) - TURN_INSET_PX;
			return Math.max(0, Math.min(target, Math.max(0, scroller.scrollHeight - scroller.clientHeight)));
		}
		/**
		* Tell the transcript that the scrollport has settled.
		*
		* Chat debounces reader sampling: after a programmatic jump it still believes it
		* follows the tail until its sample timer fires, so its follow loop keeps pulling
		* the viewport down while this plugin pushes it back — visible as a twitch. The
		* scrollport's own `scrollend` handler flushes that sample immediately, so the
		* jump is adopted in the same frame and the tug of war never starts.
		* @param scroller - Conversation scrollport.
		*/
		function announceScrollEnd(scroller) {
			if (typeof Event !== "function" || typeof scroller.dispatchEvent !== "function") return;
			try {
				scroller.dispatchEvent(new Event("scrollend"));
			} catch (_error) {}
		}
		/**
		* Apply a scroll offset and repeat it for a few frames.
		*
		* The offset is applied instantly (`behavior: "instant"`), so a stylesheet-level
		* smooth behavior cannot restart an animation on every correction frame. A newer
		* jump retires an older correction chain, so rapid presses converge on the newest
		* target.
		* @param scroller - Conversation scrollport.
		* @param target - desired scroll offset.
		* @param state - per-Conversation reading memory owning the chain token.
		*/
		function settleScroll(scroller, target, state) {
			state.token += 1;
			const token = state.token;
			let frames = 0;
			const apply = () => {
				if (state.token !== token) return;
				const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
				const top = Math.max(0, Math.min(target, max));
				if (Math.abs(scroller.scrollTop - top) > 1) {
					if (typeof scroller.scrollTo === "function") scroller.scrollTo({
						top,
						behavior: "instant"
					});
					else scroller.scrollTop = top;
				}
				announceScrollEnd(scroller);
				frames += 1;
				if (frames < SETTLE_FRAMES) window.requestAnimationFrame(apply);
			};
			apply();
		}
		/**
		* Align one Turn anchor and remember the landing.
		* @param scroller - Conversation scrollport.
		* @param entry - the target Turn's anchor row.
		* @param state - per-Conversation reading memory.
		*/
		function land(scroller, entry, state) {
			const top = offsetFor(scroller, entry.row);
			settleScroll(scroller, top, state);
			state.turn = entry.turn;
			state.top = top;
		}
		/**
		* Find the transcript's history button.
		* @param scroller - Conversation scrollport.
		* @returns the button element, or null.
		*/
		function loadEarlierButton(scroller) {
			for (const button of scroller.querySelectorAll("button")) {
				if (button.closest("[data-chat-turn]") !== null) continue;
				const text = (button.textContent ?? "").trim();
				if (LOAD_EARLIER_LABELS.has(text)) return button;
			}
			return null;
		}
		/**
		* Page one older window in, then land on the Turn just before the previous
		* head so repeated Up presses walk continuously through history.
		* @param scroller - Conversation scrollport.
		* @param state - per-Conversation reading memory.
		* @returns `true` when a page request started, `"loading"` while one is already
		* running, `false` when there is nothing older to load.
		*/
		function requestEarlier(scroller, state) {
			const button = loadEarlierButton(scroller);
			if (button === null) return false;
			if (button.disabled === true) return "loading";
			const head = turnRows(scroller)[0];
			if (head === undefined) return false;
			button.click();
			const deadline = Date.now() + LOAD_TIMEOUT_MS;
			const poll = () => {
				const rows = turnRows(scroller);
				const first = rows.length > 0 ? rows[0].turn : head.turn;
				if (first < head.turn) {
					let target;
					for (const entry of rows) if (entry.turn < head.turn) target = entry;
					if (target !== undefined) {
						const anchor = rows.find((entry) => entry.turn === target.turn);
						land(scroller, anchor ?? target, state);
					}
					return;
				}
				if (Date.now() < deadline) window.setTimeout(poll, LOAD_POLL_MS);
			};
			window.setTimeout(poll, LOAD_POLL_MS);
			return true;
		}
		/**
		* Move one step through the loaded Turns of the current Conversation.
		*
		* Down targets the first row of the next Turn; Up targets the first row of the
		* previous Turn, so a segment is always read from its start rather than from
		* its last row.
		* @param scroller - Conversation scrollport.
		* @param delta - -1 for the previous Turn, +1 for the next.
		* @param options - runtime knobs.
		* @param state - per-Conversation reading memory.
		* @returns a hint payload, or null when the Conversation has no Turn.
		*/
		function stepTurn(scroller, delta, options, state) {
			const rows = turnRows(scroller);
			if (rows.length === 0) return null;
			const current = readTurn(scroller, rows, state);
			const stamp = `turn rows=${rows.length} cur=${current} scroll=${Math.round(scroller.scrollTop)} landing=${state.turn ?? "-"}`;
			if (delta > 0) {
				for (const entry of rows) {
					if (entry.turn <= current) continue;
					land(scroller, entry, state);
					return {
						turn: entry.turn,
						trace: `${stamp} → ${entry.turn}`
					};
				}
				state.turn = current;
				state.top = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
				settleScroll(scroller, state.top, state);
				return {
					blocked: "last",
					turn: current,
					trace: `${stamp} → end`
				};
			}
			let previousTurn;
			for (const entry of rows) {
				if (entry.turn >= current) break;
				previousTurn = entry.turn;
			}
			if (previousTurn === undefined) {
				const requested = options.loadEarlier ? requestEarlier(scroller, state) : false;
				if (requested === "loading") return {
					loading: true,
					turn: current,
					trace: `${stamp} → paging`
				};
				if (requested !== true) return {
					blocked: "first",
					turn: current,
					trace: `${stamp} → start`
				};
				return {
					loading: true,
					turn: current,
					trace: `${stamp} → load earlier`
				};
			}
			const anchor = rows.find((entry) => entry.turn === previousTurn);
			land(scroller, anchor, state);
			return {
				turn: previousTurn,
				trace: `${stamp} → ${previousTurn}`
			};
		}
		//#endregion
		//#region lib/types/client/diagnostics.js
		/** How many diagnostic lines the overlay keeps. */
		const DIAG_LINES = 12;
		/** How long an automatically shown diagnostics panel stays on screen. */
		const AUTO_HIDE_MS = 6000;
		const DIAG_CSS = ".dsh-arrow-nav-diag{position:fixed;top:56px;left:12px;z-index:2147483000;box-sizing:border-box;max-width:min(46ch,38vw);pointer-events:none;padding:6px 9px;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary,#d0d0d0);background:var(--dsw-alias-bg-layer-3,rgba(24,24,26,.82));border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));box-shadow:var(--dsw-elevation-prominent,0 6px 18px rgba(0,0,0,.22));white-space:pre-wrap;overflow-wrap:anywhere;opacity:.9}.dsh-arrow-nav-diag[hidden]{display:none}.dsh-arrow-nav-diag b{color:var(--dsw-alias-state-business-primary,#6ea8fe);font-weight:600}";
		/**
		* Rolling navigation log with an on-screen overlay.
		*
		* The overlay exists because a stuck or twitching jump cannot be diagnosed from
		* the outside: it prints what the plugin actually observed (rendered rows, the
		* projection length, the resolved current Session, the branch taken) so one
		* screenshot carries the whole state. It is an explanation, not furniture: an
		* automatically shown panel fades after `AUTO_HIDE_MS` and any successful step
		* takes it down, while the reader's own `Shift+↑` keeps it up until asked again.
		*/
		var Diagnostics = class {
			lines = [];
			enabled = false;
			pinned = false;
			element = null;
			style = null;
			timer = 0;
			disposed = false;
			options;
			/** @param options - runtime knobs (the `diagnostics` switch). */
			constructor(options) {
				this.options = options;
			}
			/** Append one line, rendering it when the overlay is on. */
			log(line) {
				this.lines.push(line);
				if (this.lines.length > DIAG_LINES) this.lines.shift();
				if (this.enabled) this.render();
			}
			/** The reader's own switch: open it pinned, close it for good. */
			toggle() {
				if (this.enabled) {
					this.pinned = false;
					this.hide();
					return;
				}
				this.pinned = true;
				this.show();
			}
			/**
			* Show the overlay as an explanation, without pinning it.
			*
			* Anything the reader would call "stuck" — a blocked step, a refused key, an
			* open that changed nothing — says so on screen at the moment it happens, and
			* then gets out of the way by itself.
			* @param autoHideMs - how long the panel stays before fading.
			*/
			reveal(autoHideMs) {
				if (this.options.diagnostics === false) return;
				if (this.pinned) {
					this.render();
					return;
				}
				this.show();
				window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => {
					this.timer = 0;
					if (!this.pinned) this.hide();
				}, autoHideMs ?? this.options.autoHideMs ?? AUTO_HIDE_MS);
			}
			/** Take an automatically shown overlay down; a pinned one stays. */
			dismiss() {
				if (this.enabled && !this.pinned) this.hide();
			}
			/** Make the overlay visible, creating it on first use. */
			show() {
				if (this.disposed) return;
				this.enabled = true;
				this.render();
			}
			/** Remove the overlay element (the buffered lines survive). */
			hide() {
				window.clearTimeout(this.timer);
				this.timer = 0;
				this.enabled = false;
				this.element?.remove();
				this.element = null;
			}
			/** Draw the header plus the buffered lines. */
			render() {
				if (this.disposed) return;
				const doc = window.document;
				if (this.element === null || !this.element.isConnected) {
					const style = doc.createElement("style");
					style.setAttribute("data-plugin-css", "dsh-arrow-navigator/diag.css");
					style.textContent = DIAG_CSS;
					doc.head.appendChild(style);
					this.style = style;
					const element = doc.createElement("div");
					element.className = "dsh-arrow-nav-diag";
					doc.body.appendChild(element);
					this.element = element;
				}
				const header = `dsh-arrow-nav v${BUILD} · 6 秒后自动消失，Shift+↑ 可常驻`;
				this.element.textContent = this.lines.length === 0 ? `${header}
(还没有导航记录：按 ← / → / ↑ / ↓)` : `${header}
${this.lines.join("\n")}`;
				this.element.hidden = false;
			}
			/** Remove the overlay, its stylesheet, and its buffer. */
			dispose() {
				this.disposed = true;
				this.lines = [];
				this.pinned = false;
				this.hide();
				this.style?.remove();
				this.style = null;
			}
		};
		//#endregion
		//#region lib/types/client/hint.js
		/** How long a navigation hint stays on screen. */
		const HINT_TIMEOUT_MS = 1400;
		const HINT_CSS = ".dsh-arrow-nav-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483000;box-sizing:border-box;max-width:min(70vw,560px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;padding:6px 14px;border-radius:999px;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-bg-layer-3,rgba(28,28,30,.94));border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.28));opacity:.97}.dsh-arrow-nav-hint[hidden]{display:none}";
		/**
		* Own the single hint element: created on first use, hidden on timeout.
		*/
		var Hint = class {
			element = null;
			style = null;
			timer = 0;
			disposed = false;
			options;
			/** @param options - runtime knobs (the `hint` switch). */
			constructor(options) {
				this.options = options;
			}
			/** Remove the element, its stylesheet, and any pending timer. */
			dispose() {
				this.disposed = true;
				window.clearTimeout(this.timer);
				this.timer = 0;
				this.element?.remove();
				this.style?.remove();
				this.element = null;
				this.style = null;
			}
			/**
			* Show one line of copy.
			* @param text - already-localized hint text.
			*/
			show(text) {
				// An async step may finish after teardown; it must not build DOM again.
				if (this.disposed || !this.options.hint || text === "") return;
				const doc = window.document;
				let element = this.element;
				if (element === null || !element.isConnected) {
					const style = doc.createElement("style");
					style.setAttribute("data-plugin-css", "dsh-arrow-navigator/hint.css");
					style.textContent = HINT_CSS;
					doc.head.appendChild(style);
					this.style = style;
					element = doc.createElement("div");
					element.className = "dsh-arrow-nav-hint";
					element.setAttribute("role", "status");
					element.setAttribute("aria-live", "polite");
					element.hidden = true;
					doc.body.appendChild(element);
					this.element = element;
				}
				element.textContent = text;
				element.hidden = false;
				window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => {
					if (this.element !== null) this.element.hidden = true;
				}, HINT_TIMEOUT_MS);
			}
		};
		//#endregion
		//#region lib/types/client/input.js
		/** Overlays whose own arrow-key handling must win over navigation. */
		const POPUP_SELECTOR = "[role=\"listbox\"], [role=\"menu\"], [role=\"dialog\"], [role=\"alertdialog\"], [aria-modal=\"true\"], [data-shortcut-modal]";
		/** Popups that only own the arrows while the reader is actually inside them. */
		const ARROW_POPUP_SELECTOR = "[role=\"listbox\"], [role=\"menu\"]";
		/** Elements that own arrow keys while they hold focus. */
		const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable=\"true\"], [contenteditable=\"\"]";
		/** Whether an element is laid out and not hidden by an ancestor. */
		function laidOut(node) {
			if (node.closest("[hidden], [inert], [aria-hidden=\"true\"]") !== null) return false;
			const rect = node.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}
		/**
		* Whether an open menu or listbox is arbitrating the arrow keys right now.
		*
		* A floating layer that merely happens to be on screen — a hover preview, a
		* tooltip, a menu mounted but unattended — does not own the arrows. Only a popup
		* that holds the focus, or whose options a focused input walks with
		* `aria-activedescendant`, does; otherwise a stray overlay under the pointer
		* would silently switch navigation off in both directions.
		* @param doc - product document.
		* @param target - focused element from the input context.
		* @returns whether navigation must stand down.
		*/
		function popupOpen(doc, target) {
			if (target instanceof Element && target.closest(ARROW_POPUP_SELECTOR) !== null) return true;
			const active = doc.activeElement;
			for (const node of doc.querySelectorAll(ARROW_POPUP_SELECTOR)) {
				if (!laidOut(node)) continue;
				if (node.getAttribute("aria-activedescendant") !== null) return true;
				if (active !== null && active !== undefined && node === active) return true;
				if (active !== null && active !== undefined && node.contains(active)) return true;
			}
			return false;
		}
		/**
		* Whether a draft is visually empty.
		*
		* Rich editors leave zero-width characters behind, and `String.trim` does not
		* treat them as whitespace, so they are stripped explicitly.
		* @param text - editor value or text content.
		* @returns whether only whitespace and zero-width characters remain.
		*/
		function isBlankText(text) {
			return String(text).replace(/[\s\u200b\u200c\u200d\ufeff]/gu, "") === "";
		}
		/**
		* Whether an editable target releases its arrows to navigation.
		* Only the resident conversation composer participates, and only while its
		* editor is empty; every other text field keeps native caret behavior.
		* @param target - focused element from the input context.
		* @param options - runtime knobs.
		* @returns whether arrows may navigate.
		*/
		function editableAllows(target, options) {
			if (!(target instanceof Element)) return true;
			const editable = target.closest(EDITABLE_SELECTOR);
			if (editable === null) return true;
			if (!options.allowEmptyComposer) return false;
			if (editable.closest(COMPOSER_SELECTOR) === null) return false;
			if (editable.tagName === "SELECT") return false;
			if (typeof editable.value === "string") return isBlankText(editable.value);
			return isBlankText(editable.textContent ?? "");
		}
		/**
		* The sidebar Session row that owns the target, when there is one.
		*
		* Sidebar rows are drag-reorderable and carry their identity as
		* `data-row-key="session:<id>"`; a click inside a row keeps focus there, so
		* conversation switching must stay available from the row itself.
		* @param target - focused element from the input context.
		* @returns the row element, or null.
		*/
		function sessionRowOf(target) {
			if (!(target instanceof Element)) return null;
			const row = target.closest("[data-row-key]");
			if (row === null) return null;
			const key = row.dataset === undefined ? undefined : row.dataset.rowKey;
			return typeof key === "string" && key.startsWith("session:") ? row : null;
		}
		/**
		* Whether the focused element belongs to one of the accepted scopes.
		* @param target - focused element from the input context, possibly null.
		* @param scopes - elements allowed to receive the binding.
		* @param rows - also accept a sidebar Session row.
		* @returns whether the target is neutral or inside an accepted scope.
		*/
		function targetAllowed(target, scopes, rows = false) {
			if (target === null || target === undefined) return true;
			if (!(target instanceof Element)) return true;
			if (target === window.document.body || target === window.document.documentElement) return true;
			// Scoping is a refinement: a composition without the known markers must
			// not turn the feature off, so an empty scope set accepts the target.
			if (scopes.length === 0) return true;
			if (rows && sessionRowOf(target) !== null) return true;
			if (inMainColumn(target)) return true;
			return scopes.some((scope) => scope !== null && scope.contains(target));
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required browser services: Session catalog, shortcut registry, slots, and copy. */
		const inject = [
			"sessions",
			"shortcuts",
			"locale",
			"slots"
		];
		/** Locale dictionary namespace. */
		const NS = "arrowNav";
		const zh = {
			sessionPrev: "上一个对话",
			sessionNext: "下一个对话",
			turnPrev: "上一段对话",
			turnNext: "下一段对话",
			hintSession: "{index}/{total} · {title}",
			hintFirstSession: "已经是第一个对话",
			hintLastSession: "已经是最后一个对话",
			hintTurn: "第 {turn} 段",
			hintFirstTurn: "已经是第一段",
			hintLastTurn: "已经是最后一段",
			hintLoading: "正在加载更早的对话…",
			hintSkipped: "跳过了打不开的会话",
			hintPopup: "方向键先归打开的菜单/弹窗（Esc 可关闭）",
			hintHold: "松手打开：{title}"
		};
		const en = {
			sessionPrev: "Previous conversation",
			sessionNext: "Next conversation",
			turnPrev: "Previous segment",
			turnNext: "Next segment",
			hintSession: "{index}/{total} · {title}",
			hintFirstSession: "Already the first conversation",
			hintLastSession: "Already the last conversation",
			hintTurn: "Segment {turn}",
			hintFirstTurn: "Already the first segment",
			hintLastTurn: "Already the last segment",
			hintLoading: "Loading earlier history…",
			hintSkipped: "Skipped a conversation that cannot be opened",
			hintPopup: "Arrows belong to the open menu or dialog first (Esc closes it)",
			hintHold: "Release to open: {title}"
		};
		/**
		* Install arrow-key navigation for the browser client.
		* @param ctx - client root context carrying `sessions`, `shortcuts`, and `locale`.
		*/
		function apply(ctx) {
			const options = readOptions();
			/**
			* Reading memory for the main Conversation: the Turn a jump landed on, the
			* scroll offset it landed at, and the newest correction-chain token. It is
			* discarded implicitly when the reader scrolls (the offset no longer
			* matches) and reset when the Conversation changes.
			*/
			const reading = {
				turn: null,
				top: -1,
				token: 0,
				session: undefined
			};
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "arrow-nav: dictionaries");
			const t = ctx.locale.bind(NS);
			const hint = new Hint(options);
			ctx.effect(() => () => hint.dispose(), "arrow-nav: hint element");
			const diagnostics = new Diagnostics(options);
			ctx.effect(() => () => diagnostics.dispose(), "arrow-nav: diagnostics overlay");
			/**
			* A null-rendering occupant of the frame-wide overlay.
			*
			* It paints nothing, but it is visible to the slot inspector — which is how a
			* running page can be asked whether this build is actually loaded, instead of
			* trusting that a bundle edit reached the browser.
			* @returns nothing to render.
			*/
			const ArrowNavProbe = () => null;
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "arrow-nav-probe",
				order: 950,
				locale: NS
			}, ArrowNavProbe)), "arrow-nav: liveness probe");
			try {
				window.__dshArrowNav = {
					build: BUILD,
					toggle: () => diagnostics.toggle(),
					lines: () => [...diagnostics.lines]
				};
			} catch (_error) {}
			/**
			* Sidebar groups this navigation expanded itself, keyed by group, so the
			* expansion can be collapsed again once the reader leaves the group.
			*/
			const expansions = new Map();
			/** Sessions whose open failed, and the open that has not taken effect yet. */
			const skipped = new Set();
			ctx.effect(() => ctx.shortcuts.registerFixed({
				id: "arrowNav.sessionPrev",
				label: () => t("sessionPrev"),
				keys: ["←"],
				bindings: [{
					code: "ArrowLeft",
					modifiers: []
				}],
				group: "application"
			}), "arrow-nav: previous conversation reference");
			ctx.effect(() => ctx.shortcuts.registerFixed({
				id: "arrowNav.sessionNext",
				label: () => t("sessionNext"),
				keys: ["→"],
				bindings: [{
					code: "ArrowRight",
					modifiers: []
				}],
				group: "application"
			}), "arrow-nav: next conversation reference");
			/**
			* Guard refusals, counted by reason.
			* Every refused arrow key is recorded, and a reason that repeats three times
			* opens the diagnostics overlay. A guard that silently swallows keys is
			* indistinguishable from a bug in the product ("the arrow does nothing"), so a
			* stuck reader must be able to see which guard is refusing and why.
			*/
			const refusals = new Map();
			/**
			* Record one refused arrow key.
			* @param code - physical key code.
			* @param why - the guard that refused it.
			*/
			const refuse = (code, why) => {
				if (code !== "ArrowLeft" && code !== "ArrowRight" && code !== "ArrowUp" && code !== "ArrowDown") return;
				const count = (refusals.get(why) ?? 0) + 1;
				refusals.set(why, count);
				diagnostics.log(`${code} refused: ${why} (x${String(count)})`);
				if (count === 3) diagnostics.reveal();
				// Standing down for a popup is correct but invisible: say who owns the keys
				// so a refusing arrow never looks like a broken one.
				if (count >= 2 && (why.startsWith("modal=") || why.startsWith("popup"))) hint.show(t("hintPopup"));
			};
			/**
			* Describe the focused element for the refusal log.
			* @param target - focused element from the input context.
			* @returns a short description.
			*/
			const describeTarget = (target) => {
				if (!(target instanceof Element)) return String(target);
				const role = target.getAttribute("role");
				const key = target.dataset === undefined ? undefined : target.dataset.rowKey;
				return `<${target.tagName.toLowerCase()}${role === null ? "" : ` role=${role}`}${key === undefined ? "" : ` row=${key}`}>`;
			};

			// --- held arrow keys -------------------------------------------------
			// The shortcut service only dispatches keydown, so the release is read from
			// the window itself. Holding walks a cursor over the sidebar and opens only
			// what the cursor rests on: switching a Conversation loads its transcript, so
			// committing every repeat would thrash the app instead of feeling fast.
			/** Where a held arrow key currently points. */
			let hold = null;
			/** The row carrying the cursor highlight, so it can be cleaned up. */
			let cursorRow = null;
			/** Stylesheet for the cursor highlight, injected on first use. */
			let cursorStyle = null;
			/** Clear the sidebar cursor highlight. */
			const clearCursor = () => {
				cursorRow?.removeAttribute(CURSOR_ATTRIBUTE);
				cursorRow = null;
			};
			/**
			* Mark the Session a held arrow key would open.
			* @param list - `sessions.list` snapshot.
			* @param id - Session to mark.
			* @returns whether the row was found.
			*/
			const setCursor = (list, id) => {
				const doc = window.document;
				if (cursorStyle === null) {
					const style = doc.createElement("style");
					style.setAttribute("data-plugin-css", "dsh-arrow-navigator/cursor.css");
					style.textContent = CURSOR_CSS;
					doc.head.appendChild(style);
					cursorStyle = style;
				}
				const row = sidebarRowByKey(doc, `session:${id}`);
				clearCursor();
				if (row === null) return false;
				row.setAttribute(CURSOR_ATTRIBUTE, "true");
				cursorRow = row;
				row.scrollIntoView?.({ block: "nearest" });
				return true;
			};
			/**
			* Stop a held arrow key, opening whatever its cursor rested on.
			* @param commit - whether the release should open the cursor's Session.
			*/
			const endHold = (commit) => {
				if (hold === null) return;
				const pending = hold;
				hold = null;
				window.clearTimeout(pending.timer);
				clearCursor();
				if (!commit || pending.cursor === undefined || !pending.moved) return;
				const target = pending.cursor;
				diagnostics.log(`hold release open=${shortId(target)}`);
				try {
					openSessionStep(ctx, { id: target });
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					diagnostics.log(`open ${shortId(target)} failed: ${reason}`);
					diagnostics.reveal();
					hint.show(t("hintSkipped"));
					return;
				}
				hint.show(t("hintHold", { id: pending.label ?? shortId(target) }));
			};
			// A lost keyup (focus stolen, window switched) must not leave a live cursor.
			// Element blur must NOT end a hold: a captured `blur` on window also sees
			// every descendant losing focus, and the Session switch a press performs
			// re-renders the sidebar — which would cancel the hold on its first tick.
			const onBlur = (event) => {
				if (event !== undefined && event.target !== undefined && event.target !== window) return;
				endHold(true);
			};
			const onKeyUp = (event) => {
				if (hold === null || event.code !== hold.code) return;
				endHold(true);
			};
			window.addEventListener("keyup", onKeyUp, true);
			window.addEventListener("blur", onBlur);
			ctx.effect(() => () => {
				endHold(false);
				window.removeEventListener("keyup", onKeyUp, true);
				window.removeEventListener("blur", onBlur);
				cursorStyle?.remove();
				cursorStyle = null;
			}, "arrow-nav: held-key state");
			/**
			* Walk a held key's cursor one Session further.
			*
			* Only the highlight moves: switching a Conversation loads its transcript, so
			* committing every repeat would leave the app behind the keys (and the sidebar
			* describing a Session the view had not adopted yet). The release opens what
			* the cursor rests on.
			* @returns nothing.
			*/
			const walkCursor = () => {
				if (hold === null) return;
				const list = ctx.sessions.list.getSnapshot();
				const from = hold.cursor ?? currentSessionId(list, window.document);
				const plan = planSessionStep(ctx, hold.delta, options, skipped, from);
				if (plan === null) return;
				if (plan.expand !== undefined) {
					// A hidden region between two rows is crossed by revealing it.
					if (hold.steps >= HOLD_MAX_STEPS) return;
					hold.steps += 1;
					const wanted = hold;
					revealSidebar(plan.expand).then((grown) => {
						if (grown && hold === wanted) walkCursor();
					}).catch(() => {});
					return;
				}
				if (plan.id === undefined) {
					// End of the list, or nothing plannable: stop walking, keep the cursor.
					if (plan.blocked !== undefined) hint.show(`${plan.blocked === "last" ? t("hintLastSession") : t("hintFirstSession")} · ${BUILD}`);
					return;
				}
				setCursor(list, plan.id);
				hold.cursor = plan.id;
				hold.moved = true;
				const label = `${String(plan.index)}/${String(plan.total)} · ${plan.title}`;
				hold.label = label;
				diagnostics.log(`cursor ${shortId(plan.id)} (${label})`);
				hint.show(t("hintHold", { title: label }));
			};
			/**
			* Start (or restart) the repeat timer for a held arrow key.
			* @param code - physical key code being held.
			* @param delta - direction of travel.
			* @param gesture - the original gesture, replayed for Turn steps.
			* @param context - the original input context.
			* @param preview - whether holding walks a cursor instead of switching.
			*/
			const beginHold = (code, delta, gesture, context, preview) => {
				endHold(false);
				const holdState = {
					code,
					delta,
					gesture,
					context,
					preview,
					cursor: undefined,
					label: undefined,
					moved: false,
					steps: 0,
					pending: false,
					dispatchedOnce: false,
					dispatched: undefined,
					timer: 0
				};
				hold = holdState;
				const tick = () => {
					if (hold !== holdState) return;
					if (holdState.steps >= HOLD_MAX_STEPS) return;
					holdState.steps += 1;
					if (holdState.preview) walkCursor();
					else if (holdState.steps > 1 && !holdState.pending) {
						// A dispatch that did not move the cursor (the end of the list, or a step
						// that never landed) means repeating further would only re-open what is
						// already open, so the hold stops itself instead of spinning.
						if (holdState.dispatchedOnce && holdState.dispatched === holdState.cursor) return;
						holdState.dispatchedOnce = true;
						holdState.dispatched = holdState.cursor;
						holdState.pending = true;
						window.setTimeout(() => {
							if (hold === holdState) holdState.pending = false;
						}, HOLD_STEP_MS * 2);
						// Replay the press, walking from where this hold already landed: the
						// sidebar lags a switch by a frame or two, so the visible Session is
						// not a trustworthy starting point while keys are still repeating.
						onFixedInput({
							type: "keydown",
							gesture: holdState.gesture,
							context: holdState.context,
							holdTick: true,
							fromId: holdState.cursor,
							onLanded: (id) => {
								if (hold !== holdState) return;
								holdState.pending = false;
								holdState.cursor = id;
								holdState.moved = true;
							},
							consume: () => {}
						});
					}
					holdState.timer = window.setTimeout(tick, HOLD_STEP_MS);
				};
				// A repeat that arrives with no live hold (its state was cancelled) starts
				// the walk immediately instead of waiting out another delay.
				holdState.timer = window.setTimeout(tick, HOLD_DELAY_MS);
			};
			/**
			* Handle one arbitrated keydown. Navigation only claims the gesture when it
			* actually moved something, so every other consumer keeps its arrows.
			* @param input - fixed-input frame from the shortcut service.
			*/
			const onFixedInput = (input) => {
				if (input === null || typeof input !== "object") return;
				if (input.type !== "keydown") return;
				const gesture = input.gesture;
				const context = input.context;
				if (gesture === undefined || context === undefined) return;
				// Shift+↑ toggles the diagnostics overlay: a stuck or twitching jump has
				// to be reportable from the product itself, without developer tools.
				if (gesture.shift && !gesture.control && !gesture.alt && !gesture.meta && gesture.code === "ArrowUp" && gesture.repeat !== true && context.region !== "editable" && context.modal === null) {
					diagnostics.toggle();
					diagnostics.log(`diag ${diagnostics.enabled ? "on" : "off"}`);
					input.consume();
					return;
				}
				if (gesture.control || gesture.alt || gesture.meta || gesture.shift) return;
				const code = gesture.code;
				const horizontal = code === "ArrowLeft" || code === "ArrowRight";
				if (!horizontal && code !== "ArrowUp" && code !== "ArrowDown") return;
				const held = input.holdTick === true;
				const ours = options.holdRepeat && (horizontal || options.holdTurns === true);
				// A hold is ONE gesture: it was adjudicated when it started. Its own steps
				// (and the keyboard's repeats of it) skip the focus guards, because the
				// switching this gesture performs is what moves the focus — Chat hands it to
				// the composer after every jump, and re-reading that as "outside the
				// conversation" would let the plugin kill its own hold.
				if (ours && gesture.repeat === true && hold !== null && hold.code === code) {
					input.consume();
					return;
				}
				// Every other gesture passes every guard, repeats included.
				if (!held) {
					if (gesture.composing || gesture.defaultPrevented) {
						refuse(code, gesture.composing ? "composing" : "already-prevented");
						return;
					}
					if (context.modal !== null || context.region === "terminal") {
						refuse(code, context.modal !== null ? `modal=${context.modal}` : "terminal");
						return;
					}
					const doc = window.document;
					if (popupOpen(doc, context.target)) {
						refuse(code, `popup open, focus=${describeTarget(context.target)}`);
						return;
					}
					if (!editableAllows(context.target, options)) {
						refuse(code, `editor holds keys: ${describeTarget(context.target)}`);
						return;
					}
					const scopes = horizontal ? [...conversationScopes(doc), ...sidebarScopes(doc)] : conversationScopes(doc);
					if (!targetAllowed(context.target, scopes, horizontal)) {
						refuse(code, `focus outside the sidebar/conversation: ${describeTarget(context.target)}`);
						return;
					}
				}
				const doc = window.document;
				if (gesture.repeat) {
					// The plugin repeats held arrows from its own timer so the cadence does
					// not depend on the OS keyboard settings. Holding ←/→ is always ours;
					// holding ↑/↓ is ours only when `holdTurns` says so, because the
					// transcript's own scrolling is what a reader expects there.
					if (!ours) {
						refuse(code, "repeat");
						return;
					}
					// The gesture is ours, so its default action (scrolling the page or the
					// transcript) must stop here: otherwise the browser scrolls while the
					// plugin steps, and the two fight over the same frame.
					input.consume();
					const repeatDelta = horizontal ? code === "ArrowLeft" ? -1 : 1 : code === "ArrowUp" ? -1 : 1;
					beginHold(code, repeatDelta, gesture, context, horizontal && options.holdPreview === true);
					onFixedInput({
						type: "keydown",
						gesture,
						context,
						holdTick: true,
						fromId: undefined,
						onLanded: (id) => {
							if (hold !== null && hold.code === code) {
								hold.cursor = id;
								hold.moved = true;
							}
						},
						consume: () => {}
					});
					return;
				}
				if (horizontal) {
					const delta = code === "ArrowLeft" ? -1 : 1;
					input.consume();
					// The first press always lands somewhere; holding then walks ahead of it.
					if (!held && ours) beginHold(code, delta, gesture, context, options.holdPreview === true);
					const list = ctx.sessions.list.getSnapshot();
					const current = input.fromId ?? currentSessionId(list, doc);
					if (options.autoCollapse && expansions.size > 0) {
						// The reader may have left an expanded group by other means (a click,
						// a second window): unwind anything the current Session no longer owns
						// before planning this step.
						collapseExpansions(doc, expansions, groupOfSession(doc, list, current));
					}
					const plan = planSessionStep(ctx, delta, options, skipped, input.fromId);
					if (plan === null || plan.expand === undefined && plan.id === undefined && plan.blocked === undefined) {
						// No actionable step: the list is not ready, or the step resolved back to
						// the current Session. Report it instead of aiming an id-less open at the
						// Session controller, which would throw and retry forever.
						diagnostics.log(`[${code}] no target ${plan?.trace ?? ""}`);
						diagnostics.reveal();
						hint.show(`${delta > 0 ? t("hintLastSession") : t("hintFirstSession")} · ${BUILD}`);
						input.consume();
						return;
					}
					diagnostics.log(`[${code}] ${plan.trace ?? ""}`);
					input.consume();
					const announce = (result) => {
						diagnostics.log(`[${code}] result ${result.blocked ?? (result.expand === undefined ? `open ${result.id}` : `expand ${result.expand.key}`)}`);
						if (result.blocked === "first") {
							diagnostics.reveal();
							hint.show(`${t("hintFirstSession")} · ${BUILD}`);
						} else if (result.blocked === "last") {
							diagnostics.reveal();
							hint.show(`${t("hintLastSession")} · ${BUILD}`);
						} else {
							// The step worked: an explaining panel has nothing left to explain.
							diagnostics.dismiss();
							hint.show(t("hintSession", {
								index: result.index,
								total: result.total,
								title: result.title
							}));
						}
					};
					/**
					* Apply a plan, driving the sidebar's own expand affordances until the
					* target Session is rendered. One group can need several rounds (a
					* collapsed group, then its "remaining rows" batches), so rounds are
					* bounded and a retry that reveals nothing reports the end instead.
					* @param current - the plan to apply.
					* @param rounds - expansion rounds already spent.
					* @param misses - failed opens already walked past in this step.
					*/
					const applyPlan = async (current, rounds, misses) => {
						if (current === null || current === undefined) return;
						const end = () => announce({ blocked: delta > 0 ? "last" : "first" });
						if (current.expand !== undefined) {
							if (rounds >= MAX_EXPAND_ROUNDS) {
								end();
								return;
							}
							if (options.autoCollapse) expansions.set(current.expand.group, current.expand);
							const grown = await revealSidebar(current.expand);
							if (!grown) {
								end();
								return;
							}
							await applyPlan(planSessionStep(ctx, delta, options, skipped, input.fromId), rounds + 1, misses);
							return;
						}
						if (current.blocked !== undefined) {
							announce(current);
							return;
						}
						if (typeof current.id !== "string" || current.id === "") {
							// A plan without a Session can never be applied; report the end
							// instead of retrying forever.
							diagnostics.log(`no target ${current.trace ?? ""}`);
							end();
							return;
						}
						try {
							openSessionStep(ctx, current);
							// A healthy open is recognised synchronously; only a lagging one waits,
							// and one that never lands ends this press as an ordinary skip.
							if (!retainedAsMain(ctx, current.id) && !await openedTook(ctx, current.id, OPEN_SETTLE_MS)) {
								throw new Error("open did not take effect");
							}
						} catch (error) {
							// An unopenable Session must not become a wall: remember it and walk on.
							skipped.add(current.id);
							const reason = error instanceof Error ? error.message : String(error);
							diagnostics.log(`open ${shortId(current.id)} failed: ${reason}`);
							diagnostics.reveal();
							// Bound the walk by attempts, not by set size: a repeated target must
							// not be able to spin here forever.
							if (misses + 1 > MAX_SKIP_ROUNDS) {
								end();
								return;
							}
							hint.show(t("hintSkipped"));
							await applyPlan(planSessionStep(ctx, delta, options, skipped), rounds, misses + 1);
							return;
						}
						if (options.autoCollapse) {
							// Leaving a group unwinds the expansion that let us cross it. A row
							// the sidebar still hides keeps its group through the projection.
							const owned = ctx.sessions.list.getSnapshot();
							const workspaces = ctx.get("workspaces")?.list?.getSnapshot?.();
							const keep = groupOfSession(doc, owned, current.id) ?? groupOfSessionService(workspaces, current.id);
							collapseExpansions(doc, expansions, keep);
						}
						announce(current);
						// Report the landing so a held key keeps walking from here, not from a
						// sidebar that may still describe the Session we just left.
						if (hold !== null) {
							hold.cursor = current.id;
							hold.moved = true;
						}
						input.onLanded?.(current.id);
					};
					applyPlan(plan, 0, 0).catch((error) => {
						diagnostics.log(`step failed: ${error instanceof Error ? error.message : String(error)}`);
						console.error("[arrow-nav] conversation step failed", error);
					});
					return;
				}
				const scroller = scrollerFor(doc);
				if (scroller === null) return;
				const turnDelta = code === "ArrowUp" ? -1 : 1;
				input.consume();
				// Turns are cheap to land repeatedly, so a held key can step them live —
				// but only on request: scrolling the transcript is what ↑/↓ already do.
				if (!held && ours && !horizontal) beginHold(code, turnDelta, gesture, context, false);
				// Prefer the transcript's own rail: it owns paging, follow-pausing and
				// landing, so the jump cannot fight the reading policy.
				const rail = code === "ArrowUp" || code === "ArrowDown" ? stepTurnByRail(doc, scroller, turnDelta) : null;
				if (rail !== null) {
					diagnostics.log(`[${code}] ${rail.trace}`);
					input.consume();
					diagnostics.dismiss();
					if (rail.railTurn === undefined) hint.show(t("hintTurn", { turn: turnDelta > 0 ? "+1" : "-1" }));
					else hint.show(t("hintTurn", { turn: rail.railTurn }));
					return;
				}
				// A different Conversation owns a different reading position.
				const occurrence = scroller.closest("[data-conversation-session]");
				const sessionKey = occurrence === null ? undefined : occurrence.dataset.conversationSession;
				if (sessionKey !== reading.session) {
					reading.session = sessionKey;
					reading.turn = null;
					reading.top = -1;
				}
				const result = stepTurn(scroller, turnDelta, options, reading);
				if (result === null) {
					diagnostics.log(`[${code}] no turn rows`);
					return;
				}
				diagnostics.log(`[${code}] ${result.trace ?? ""}`);
				input.consume();
				if (result.loading === true) hint.show(t("hintLoading"));
				else if (result.blocked === "first") hint.show(`${t("hintFirstTurn")} · ${BUILD}`);
				else if (result.blocked === "last") hint.show(`${t("hintLastTurn")} · ${BUILD}`);
				else {
					diagnostics.dismiss();
					hint.show(t("hintTurn", { turn: result.turn }));
				}
			};
			ctx.effect(() => ctx.shortcuts.observeFixedInput(onFixedInput), "arrow-nav: fixed input observer");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		/** Pure helpers exposed for the package's own node-level tests. */
		exports.__internals = {
			DEFAULT_OPTIONS,
			OPTIONS_KEY,
			readOptions,
			sessionVisible,
			sectionMembers,
			orderedSessions,
			currentSessionId,
			domSessionRows,
			sidebarEntries,
			groupAffordance,
			projectSessionOrder,
			planSessionStep,
			openSessionStep,
			stepTurn,
			readTurn,
			turnRows,
			settleScroll,
			readingEntry,
			offsetFor,
			scrollerFor,
			turnRail,
			stepTurnByRail,
			conversationScopes,
			sidebarScopes,
			editableAllows,
			popupOpen,
			targetAllowed
		};
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
