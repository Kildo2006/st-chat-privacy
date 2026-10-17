/* SillyTavern start page. Chat contents remain in native storage. */
(() => {
    'use strict';
    if (globalThis.__stChatPrivacyLoaded) return;
    globalThis.__stChatPrivacyLoaded = true;
    const root = document.documentElement;
    const stateAttribute = 'data-stpv-state';
    const storageKey = 'stpv_navigation_v2';
    const navigationSelector = '.character_select, .group_select, .recentChat, .select_chat_block';
    const homePressSelector = '.welcomeHeaderVersionDisplay, .welcomeHeaderLogo';
    const inertStates = new Map();
    root.removeAttribute(stateAttribute);
    root.removeAttribute('data-stpv-recents');
    root.removeAttribute('data-stpv-manager');
    const guard = document.createElement('style');
    guard.id = 'stpv-critical-style';
    guard.textContent = [
        'html:not([data-stpv-state="open"]):not([data-stpv-state="home"]) #sheld > :not(.stpv-ui),',
        'html:not([data-stpv-state="open"]):not([data-stpv-state="home"]) #sheld > :not(.stpv-ui) * {',
        'visibility:hidden!important;pointer-events:none!important;',
        'transition:none!important;animation:none!important;}',
        'html:not([data-stpv-state="open"]) #stpv-home{display:none!important;}',
        'html[data-stpv-state="open"] #stpv-cover,html[data-stpv-state="home"] #stpv-cover{display:none!important;}',
        '.welcomePanel .showRecentChats{display:none!important;}',
        'html:not([data-stpv-recents="open"]) .welcomePanel :is(.welcomeRecent,.recentChatsTitle,.recentChatsSettings,.hideRecentChats){display:none!important;}',
        'html[data-stpv-recents="open"] .welcomePanel .welcomeRecent,html[data-stpv-recents="open"] .welcomePanel .recentChatsTitle{display:block!important;}',
        'html[data-stpv-recents="open"] .welcomePanel :is(.recentChatsSettings,.hideRecentChats){display:flex!important;}',
        'html:not([data-stpv-state="open"]):not([data-stpv-manager="open"]) #shadow_select_chat_popup{display:none!important;}',
        'html[data-stpv-manager="open"] #shadow_select_chat_popup{display:block!important;opacity:1!important;}',
    ].join('\n');
    document.head.appendChild(guard);

    let open = false, hooksReady = false, busy = false, navigationPending = false;
    let epoch = 0, shownRef = null, gateTarget = null, message = '', press = null;
    let recentsOpen = false, managerOwner = null;
    let shell, cover, heading, status, newButton, homeButton, corePromise, groupsPromise;

    function context() {
        try { return globalThis.SillyTavern?.getContext?.() ?? null; }
        catch { return null; }
    }
    function validName(value) {
        return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
            !/[\x00\r\n/\\]/.test(value);
    }
    function validRef(value) {
        return value && ['character', 'group'].includes(value.kind) &&
            validName(value.owner) && validName(value.file);
    }
    function currentRef() {
        const c = context();
        if (!c || !validName(c.chatId)) return null;
        if (c.groupId !== undefined && c.groupId !== null && String(c.groupId) !== '') {
            return { kind: 'group', owner: String(c.groupId), file: c.chatId };
        }
        const character = c.characters?.[c.characterId];
        if (!character || !validName(character.avatar)) return null;
        return { kind: 'character', owner: character.avatar, file: c.chatId };
    }
    function ownerKey(ref) { return JSON.stringify([ref.kind, ref.owner]); }
    function sameOwner(a, b) { return !!a && !!b && a.kind === b.kind && a.owner === b.owner; }
    function sameRef(a, b) { return sameOwner(a, b) && a.file === b.file; }
    function withoutSuffix(value) { return String(value).replace(/\.jsonl$/, ''); }
    function fail(text) { throw new Error('STPV:' + text); }
    function isHome() {
        const c = context();
        return hooksReady && !busy && !navigationPending && c &&
            (c.characterId === undefined || c.characterId === null) &&
            (c.groupId === undefined || c.groupId === null || c.groupId === '') &&
            !!document.querySelector('#chat .welcomePanel');
    }
    function closeManager() {
        managerOwner = null;
        root.removeAttribute('data-stpv-manager');
        const popup = document.getElementById('shadow_select_chat_popup');
        if (popup) popup.style.display = 'none';
    }
    function syncView() {
        if (open) root.setAttribute(stateAttribute, 'open');
        else if (isHome()) root.setAttribute(stateAttribute, 'home');
        else root.removeAttribute(stateAttribute);
        if (recentsOpen && isHome() && !document.hidden) root.setAttribute('data-stpv-recents', 'open');
        else root.removeAttribute('data-stpv-recents');
        if (managerOwner && !busy && sameOwner(currentRef(), managerOwner) && !document.hidden) {
            root.setAttribute('data-stpv-manager', 'open');
        } else root.removeAttribute('data-stpv-manager');
        updateInert();
    }

    function entries() {
        try {
            const data = JSON.parse(context()?.accountStorage?.getItem(storageKey) ?? 'null');
            if (data?.version === 2 && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
                return data.entries;
            }
        } catch { /* Invalid metadata is ignored. */ }
        return Object.create(null);
    }
    function entryTarget(ref) {
        if (!ref) return null;
        const saved = entries()[ownerKey(ref)];
        if (validRef(saved?.previous) && sameOwner(saved.previous, ref) &&
            (saved.created === null || (validRef(saved.created) && sameRef(saved.created, ref)))) {
            return { ...saved.previous };
        }
        return { ...ref };
    }
    async function storeEntry(ref, value, core) {
        const storage = context()?.accountStorage;
        if (!storage?.setItem) fail('无法保存聊天入口，请刷新后重试。');
        const data = entries();
        if (value === undefined) delete data[ownerKey(ref)];
        else data[ownerKey(ref)] = value;
        storage.setItem(storageKey, JSON.stringify({ version: 2, entries: data }));
        // Native saveSettings catches server failures rather than rejecting.
        // Its success-only event must fire before a new chat can be created.
        const c = context();
        const type = (c.eventTypes ?? c.event_types)?.SETTINGS_UPDATED;
        if (!type || !c.eventSource?.removeListener) fail('无法确认聊天入口已保存，请刷新后重试。');
        let saved = false;
        const onSaved = () => { saved = true; };
        c.eventSource.on(type, onSaved);
        try {
            await core.saveSettings();
            if (!saved) fail('聊天入口未能保存，请稍后重试。');
        } finally {
            c.eventSource.removeListener(type, onSaved);
        }
    }
    async function coreApi() {
        corePromise ??= import('/script.js').catch(error => { corePromise = undefined; throw error; });
        const core = await corePromise;
        for (const name of ['doNewChat', 'closeCurrentChat', 'openCharacterChat', 'getPastCharacterChats', 'saveChatConditional', 'saveSettings', 'isGenerating']) {
            if (typeof core[name] !== 'function') fail('当前酒馆接口不兼容，请刷新后重试。');
        }
        return core;
    }

    function element(tag, className, text) {
        const result = document.createElement(tag);
        if (className) result.className = className;
        if (text) result.textContent = text;
        return result;
    }
    function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }
    function disable(node, value) { if (node && node.disabled !== value) node.disabled = value; }
    function updateInert() {
        if (!shell) return;
        if (['open', 'home'].includes(root.getAttribute(stateAttribute))) {
            for (const [node, wasInert] of inertStates) node.toggleAttribute('inert', wasInert);
            inertStates.clear();
        } else {
            for (const node of shell.children) {
                if (node.classList.contains('stpv-ui')) continue;
                if (!inertStates.has(node)) inertStates.set(node, node.hasAttribute('inert'));
                if (!node.hasAttribute('inert')) node.setAttribute('inert', '');
            }
        }
    }
    function cancelPress() {
        if (press) clearTimeout(press.timer);
        press = null;
    }
    function lockView() {
        root.removeAttribute(stateAttribute);
        open = false;
        shownRef = null;
        const active = document.activeElement;
        if (active && shell?.contains(active) && !active.closest('.stpv-ui')) active.blur?.();
        updateInert();
    }
    function hide(reason = 'privacy') {
        if (reason === 'entry') gateTarget = entryTarget(currentRef());
        else if (open) gateTarget = currentRef();
        epoch++;
        cancelPress();
        recentsOpen = false;
        closeManager();
        lockView();
        message = '';
        render();
    }
    function reveal(ref, expectedEpoch) {
        if (expectedEpoch !== epoch || document.hidden || !sameRef(currentRef(), ref)) return;
        shownRef = { ...ref };
        gateTarget = { ...ref };
        open = true;
        syncView();
        heading?.blur();
    }
    function render() {
        if (!cover) return;
        const ref = currentRef();
        setText(heading, ref || navigationPending ? '是否新建一个聊天？' : '开始新的对话');
        const idle = ref ? '为当前角色开启一段新对话。' : '从右侧选择一张角色卡。';
        setText(status, !hooksReady ? '起始页尚未就绪，请刷新页面。' :
            busy ? '正在处理，请稍候…' : navigationPending ? '正在打开角色…' : message || idle);
        disable(newButton, !hooksReady || busy || navigationPending || !ref);
        disable(homeButton, !hooksReady || busy || navigationPending || !ref);
        syncView();
    }
    function assertOwner(ref, core, allowGenerating = false) {
        if (!sameOwner(currentRef(), ref)) fail('角色已切换，请重新操作。');
        if (!allowGenerating && core.isGenerating()) fail('请先停止生成，再进行此操作。');
    }
    async function exists(ref, core, requireOwner = true) {
        if (requireOwner) assertOwner(ref, core);
        if (ref.kind === 'group') {
            const group = context()?.groups?.find(item => String(item.id) === ref.owner);
            return Array.isArray(group?.chats) && group.chats.includes(ref.file);
        }
        const index = context().characters.findIndex(item => item.avatar === ref.owner);
        if (index < 0) return false;
        const chats = await core.getPastCharacterChats(index);
        if (requireOwner) assertOwner(ref, core);
        return Array.isArray(chats) && chats.some(chat => withoutSuffix(chat.file_name) === ref.file);
    }
    async function act(callback, allowGenerating = false) {
        if (!hooksReady || busy || navigationPending || !currentRef() || document.hidden) return;
        const start = currentRef();
        const expectedEpoch = epoch;
        busy = true;
        cancelPress();
        lockView();
        message = '';
        render();
        try {
            const core = await coreApi();
            assertOwner(start, core, allowGenerating);
            if (expectedEpoch !== epoch || document.hidden) return;
            const result = await callback(start, core);
            if (result) reveal(result, expectedEpoch);
        } catch (error) {
            message = error instanceof Error && error.message.startsWith('STPV:')
                ? error.message.slice(5) : '操作未完成，请稍后重试。';
        } finally {
            busy = false;
            render();
        }
    }

    async function startNewChat() {
        await act(async (before, core) => {
            if (document.getElementById('send_textarea')?.value?.trim()) {
                fail('输入框还有未发送内容，请先处理后再新建。');
            }
            await core.saveChatConditional();
            assertOwner(before, core);
            if (!await exists(before, core)) fail('未能确认当前聊天已保存，请稍后重试。');
            const previousEntry = entries()[ownerKey(before)];
            let pendingStored = false;
            try {
                pendingStored = true;
                await storeEntry(before, { previous: before, created: null }, core);
                assertOwner(before, core);
                await core.doNewChat({ deleteCurrentChat: false });
                const after = currentRef();
                if (!sameOwner(after, before) || sameRef(after, before)) fail('未能新建聊天，请稍后重试。');
                if (!await exists(after, core)) fail('新聊天尚未保存，请稍后重试。');
                await storeEntry(before, { previous: before, created: after }, core);
                return after;
            } catch (error) {
                if (pendingStored && sameRef(currentRef(), before)) {
                    try { await storeEntry(before, previousEntry, core); } catch { /* Gate stays closed. */ }
                }
                throw error;
            }
        });
    }
    async function restoreChat() {
        const requested = gateTarget ?? entryTarget(currentRef());
        await openChosenChat(requested);
    }
    async function openChosenChat(requested) {
        if (!validRef(requested)) return;
        closeManager();
        await act(async (before, core) => {
            if (!sameOwner(before, requested)) fail('请重新进入该角色后再操作。');
            if (sameRef(before, requested)) return before;
            if (document.getElementById('send_textarea')?.value?.trim()) {
                fail('输入框还有未发送内容，请先处理后再切换聊天。');
            }
            await core.saveChatConditional();
            assertOwner(before, core);
            if (!await exists(requested, core)) fail('暂时无法恢复这段对话，请到聊天管理中确认。');
            assertOwner(before, core);
            if (requested.kind === 'group') await context().openGroupChat(requested.owner, requested.file);
            else await core.openCharacterChat(requested.file);
            if (!sameRef(currentRef(), requested)) fail('未能切换聊天，请稍后重试。');
            return requested;
        }, sameRef(currentRef(), requested));
    }
    async function showManager() {
        const expectedEpoch = epoch;
        closeManager();
        await act(async (before, core) => {
            if (typeof core.displayPastChats !== 'function') fail('当前酒馆不支持打开聊天管理。');
            await core.saveChatConditional();
            assertOwner(before, core);
            await core.displayPastChats();
            if (expectedEpoch === epoch && sameRef(currentRef(), before) && !document.hidden) {
                managerOwner = { ...before };
            }
            return null;
        });
    }
    async function openRecent(requested) {
        if (!validRef(requested) || !hooksReady || busy || !isHome() || !recentsOpen || document.hidden) return;
        hide();
        const expectedEpoch = epoch;
        busy = true;
        lockView();
        render();
        try {
            const core = await coreApi();
            if (core.isGenerating()) fail('请先停止生成，再进行此操作。');
            if (document.getElementById('send_textarea')?.value?.trim()) fail('输入框还有未发送内容，请先处理后再切换聊天。');
            if (!await exists(requested, core, false)) fail('暂时找不到这段聊天，请返回首页刷新列表。');
            if (expectedEpoch !== epoch || document.hidden) return;
            if (requested.kind === 'character') {
                if (typeof core.selectCharacterById !== 'function') fail('当前酒馆不支持打开角色。');
                const index = context().characters.findIndex(item => item.avatar === requested.owner);
                await core.selectCharacterById(index);
            } else {
                groupsPromise ??= import('/scripts/group-chats.js').catch(error => { groupsPromise = undefined; throw error; });
                const groups = await groupsPromise;
                if (typeof groups.openGroupById !== 'function') fail('当前酒馆不支持打开群聊。');
                if (expectedEpoch !== epoch || document.hidden) return;
                await groups.openGroupById(requested.owner);
            }
            assertOwner(requested, core);
            if (expectedEpoch !== epoch || document.hidden) return;
            if (!sameRef(currentRef(), requested)) {
                if (!await exists(requested, core)) fail('暂时找不到这段聊天，请返回首页刷新列表。');
                if (expectedEpoch !== epoch || document.hidden) return;
                if (requested.kind === 'group') await context().openGroupChat(requested.owner, requested.file);
                else await core.openCharacterChat(requested.file);
            }
            if (!sameRef(currentRef(), requested)) fail('未能打开选中的聊天，请重试。');
            if (requested.kind === 'group') core.setActiveGroup?.(requested.owner);
            else core.setActiveCharacter?.(requested.owner);
            core.saveSettingsDebounced?.();
            reveal(requested, expectedEpoch);
        } catch (error) {
            message = error instanceof Error && error.message.startsWith('STPV:')
                ? error.message.slice(5) : '操作未完成，请稍后重试。';
        } finally {
            busy = false;
            render();
        }
    }
    async function returnHome() {
        await act(async (_before, core) => {
            const closed = await core.closeCurrentChat();
            if (!closed) fail('请先停止生成，再返回首页。');
            gateTarget = null;
            return null;
        });
    }

    function startPress(event, action = 'chat') {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.isPrimary === false || busy || navigationPending || !hooksReady || document.hidden) return;
        if (action === 'home' ? !isHome() : !currentRef()) return;
        cancelPress();
        const startEpoch = epoch;
        const start = currentRef();
        const target = event.target;
        const manager = action === 'chat' && event.altKey;
        const token = { x: event.clientX ?? 0, y: event.clientY ?? 0, timer: null, target };
        token.timer = setTimeout(() => {
            if (press !== token) return;
            press = null;
            if (epoch !== startEpoch || document.hidden || !target.isConnected) return;
            if (action === 'home' && isHome()) {
                recentsOpen = !recentsOpen;
                syncView();
            } else if (sameRef(currentRef(), start)) {
                if (manager) void showManager();
                else void restoreChat();
            }
        }, 2000);
        press = token;
    }
    function ensureUi() {
        if (!shell) return;
        if (!cover || !shell.contains(cover)) {
            cover = element('section', 'stpv-ui');
            cover.id = 'stpv-cover';
            cover.setAttribute('aria-label', '聊天起始页');
            const card = element('div', 'stpv-card');
            card.appendChild(element('div', 'stpv-icon', '+'));
            heading = element('h2', '', '是否新建一个聊天？');
            heading.id = 'stpv-title';
            heading.tabIndex = -1;
            heading.addEventListener('pointerdown', event => startPress(event));
            heading.addEventListener('pointerleave', cancelPress);
            heading.addEventListener('contextmenu', event => event.preventDefault());
            card.appendChild(heading);
            status = element('p', 'stpv-status');
            status.setAttribute('aria-live', 'polite');
            card.appendChild(status);
            const actions = element('div', 'stpv-actions');
            newButton = element('button', 'stpv-button', '新建聊天');
            newButton.id = 'stpv-new';
            newButton.type = 'button';
            newButton.addEventListener('click', () => void startNewChat());
            homeButton = element('button', 'stpv-secondary', '返回首页');
            homeButton.id = 'stpv-home-action';
            homeButton.type = 'button';
            homeButton.addEventListener('click', () => void returnHome());
            actions.append(newButton, homeButton);
            card.appendChild(actions);
            cover.appendChild(card);
            shell.appendChild(cover);
        }
        if (!shell.querySelector('#stpv-home')) {
            const button = element('button', 'stpv-ui stpv-home-button', '起始页');
            button.id = 'stpv-home';
            button.type = 'button';
            button.addEventListener('click', () => hide());
            shell.appendChild(button);
        }
        render();
    }
    function onChatChanged() {
        cancelPress();
        recentsOpen = false;
        closeManager();
        lockView();
        navigationPending = false;
        if (!busy) {
            epoch++;
            gateTarget = entryTarget(currentRef());
            message = '';
        }
        render();
    }
    function beforeNavigation(event) {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest('.welcomePanel .hideRecentChats')) {
            if (event.type === 'click') {
                event.preventDefault();
                event.stopImmediatePropagation();
                recentsOpen = false;
                syncView();
            }
            return;
        }
        if (event.type === 'click' && event.target.closest('#select_chat_cross')) {
            closeManager();
            return;
        }
        if (event.target.closest('#newChatFromManageScreenButton') && (open || managerOwner || busy)) {
            if (event.type === 'click') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!busy) { closeManager(); void startNewChat(); }
            }
            return;
        }
        const target = event.target.closest(navigationSelector);
        if (!target) return;
        if (busy) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (target.classList.contains('recentChat')) {
            if (!isHome() || !recentsOpen) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (event.target.closest('.chatActions')) return;
            if (event.type === 'click') {
                event.preventDefault();
                event.stopImmediatePropagation();
                const group = target.getAttribute('data-group');
                const ref = { kind: group ? 'group' : 'character',
                    owner: group || target.getAttribute('data-avatar'), file: target.getAttribute('data-file') };
                void openRecent(ref);
            }
            return;
        }
        if (target.classList.contains('select_chat_block')) {
            const allowed = open || sameOwner(managerOwner, currentRef());
            if (allowed && event.target.closest('.renameChatButton, .exportRawChatButton, .exportChatButton, .PastChat_cross')) return;
            if (event.type === 'click') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (allowed) {
                    const before = currentRef();
                    if (before) void openChosenChat({ ...before, file: withoutSuffix(target.getAttribute('file_name') ?? '') });
                }
            }
            return;
        }
        hide('entry');
        if (event.type !== 'click') return;
        const c = context();
        const sameCharacter = target.classList.contains('character_select') &&
            !c?.groupId && String(target.getAttribute('data-chid')) === String(c?.characterId);
        const sameGroup = target.classList.contains('group_select') && c?.groupId &&
            String(target.getAttribute('data-chid') || target.getAttribute('data-grid')) === String(c.groupId);
        navigationPending = !(sameCharacter || sameGroup);
        render();
    }
    function initialize() {
        shell = document.getElementById('sheld');
        if (!shell) return;
        const c = context();
        const types = c?.eventTypes ?? c?.event_types;
        hooksReady = !!(c?.eventSource?.on && types?.CHAT_CHANGED && c.accountStorage?.getItem && c.accountStorage?.setItem);
        ensureUi();
        gateTarget = entryTarget(currentRef());
        lockView();
        if (hooksReady) {
            c.eventSource.on(types.CHAT_CHANGED, onChatChanged);
            if (types.APP_READY) c.eventSource.on(types.APP_READY, onChatChanged);
        }
        const observer = new MutationObserver(() => {
            if (open && !sameRef(currentRef(), shownRef)) {
                hide('entry');
                navigationPending = true;
            }
            ensureUi();
        });
        observer.observe(shell, { childList: true, subtree: true });
        render();
    }

    document.addEventListener('pointerdown', beforeNavigation, true);
    document.addEventListener('click', beforeNavigation, true);
    document.addEventListener('pointerdown', event => {
        if (event.target instanceof Element && event.target.closest(homePressSelector)?.closest('.welcomePanel')) {
            startPress(event, 'home');
        }
    }, true);
    document.addEventListener('pointerout', event => {
        if (press && event.target === press.target && !press.target.contains(event.relatedTarget)) cancelPress();
    }, true);
    document.addEventListener('contextmenu', event => {
        if (event.target instanceof Element && event.target.closest(homePressSelector)) event.preventDefault();
    }, true);
    document.addEventListener('pointerup', cancelPress, true);
    document.addEventListener('pointercancel', cancelPress, true);
    document.addEventListener('pointermove', event => {
        if (press && Math.hypot((event.clientX ?? 0) - press.x, (event.clientY ?? 0) - press.y) > 12) cancelPress();
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { hide(); heading?.focus({ preventScroll: true }); return; }
        if (!open && !isHome() && event.target instanceof Element && shell?.contains(event.target) && !event.target.closest('.stpv-ui')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); });
    window.addEventListener('pagehide', () => hide());
    window.addEventListener('pageshow', () => hide('entry'));
    if (document.getElementById('sheld')) initialize();
    else document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();
