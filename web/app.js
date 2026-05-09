// tick dashboard — vanilla JS, no framework, no build step

const $ = (s, p) => (p || document).querySelector(s)
const $$ = (s, p) => [...(p || document).querySelectorAll(s)]

// ── Persistent UI State (survives refresh cycles) ──
let currentView = 'overview'
let logAutoScroll = true
let logEventSource = null
let memoryFilter = ''
let memoryTypeFilter = ''
let pollTimer = null
const expandedMemKeys = new Set()       // tracks which memory items are expanded
const collapsedPromptSections = new Set(['System Prompt']) // tracks collapsed prompt sections
let inboxSubTab = 'in'
let inboxChannelFilter = ''

// ── Theme ──
function initTheme() {
  const saved = localStorage.getItem('tick-theme') || 'dark'
  applyTheme(saved)
  $('#theme-toggle').addEventListener('click', cycleTheme)
}

function cycleTheme() {
  const current = document.documentElement.dataset.theme || 'dark'
  const next = current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark'
  applyTheme(next)
  localStorage.setItem('tick-theme', next)
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  const icons = { dark: '\u{1f319}', light: '\u2600\ufe0f', auto: '\u{1f500}' }
  $('#theme-toggle').textContent = icons[theme] || icons.dark
  $('#theme-toggle').title = `Theme: ${theme}`
}

// ── Token cost estimation ──
// Rough pricing per 1M tokens (input/output blended average)
const COST_PER_1M = {
  'qwen3.6-plus': 0.50,      // opencode-go pricing
  'deepseek-v4-flash': 0.14,
  'claude-sonnet-4-20250514': 3.00,
  'gpt-4o': 2.50,
  'default': 0.50,
}

function estimateCost(tokensIn, tokensOut, model) {
  const rate = COST_PER_1M[model] || COST_PER_1M.default
  return ((tokensIn + tokensOut) / 1_000_000) * rate
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  initTheme()
  setupNav()
  setupLogs()
  setupInboxTabs()
  startPolling()
  connectLogs()
})

// ── Navigation ──
function setupNav() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      currentView = tab.dataset.view
      $$('.tab').forEach(t => t.classList.toggle('active', t === tab))
      $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${currentView}`))
      refresh()
    })
  }
}

// ── Polling ──
function startPolling() {
  refresh()
  pollTimer = setInterval(refresh, 3000)
}

async function refresh() {
  try {
    const status = await api('/api/status')
    renderHeader(status)
    if (currentView === 'overview') renderOverview(status)
    if (currentView === 'memory') await renderMemory()
    if (currentView === 'activity') await renderActivity()
    if (currentView === 'prompt') await renderPrompt()
    if (currentView === 'inbox') await renderInbox()
    if (currentView === 'usage') await renderUsage(status)
  } catch (err) {
    console.error('Poll failed:', err)
  }
}

async function api(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// ── Header ──
function renderHeader(s) {
  $('#agent-name').textContent = s.agent.name
  $('#agent-model').textContent = s.agent.model

  const badge = $('#status-badge')
  badge.className = `status-badge ${s.status}`
  $('#status-text').textContent = s.status

  if (s.lastTick) {
    const ago = timeSince(s.lastTick.startedAt)
    $('#tick-info').textContent = `#${s.lastTick.tickNumber} \u00b7 ${ago} ago \u00b7 ${s.lastTick.durationMs}ms`
  }

  $('#stat-inbox').textContent = s.stats.unreadInbox > 0 ? `${s.stats.unreadInbox}/${s.stats.totalInbox}` : s.stats.totalInbox
  $('#stat-outbox').textContent = s.stats.pendingOutbox > 0 ? `${s.stats.pendingOutbox} pending` : `${s.stats.sentOutbox} sent`
  $('#stat-memory').textContent = s.stats.memoryKeys

  const totalTok = s.stats.tokensIn + s.stats.tokensOut
  const cost = estimateCost(s.stats.tokensIn, s.stats.tokensOut, s.agent.model)
  $('#stat-tokens').textContent = formatTokens(totalTok)
  $('#stat-cost').textContent = `$${cost.toFixed(2)}`

  // Highlight unread
  $('#pill-inbox').style.borderColor = s.stats.unreadInbox > 0 ? 'var(--yellow)' : ''
}

// ── Overview ──
function renderOverview(s) {
  $('#scratchpad').textContent = s.scratchpad || '(empty)'

  // Timers
  const timersEl = $('#timers')
  if (s.timers && s.timers.length > 0) {
    timersEl.innerHTML = s.timers.map(t => {
      const fireAt = new Date(t.fireAt).toLocaleTimeString()
      const remaining = timeSince(new Date(t.fireAt).toISOString(), true)
      return `<div class="act-item">
        <span class="act-icon">\u23f0</span>
        <span>${esc(t.reason)} \u2014 fires at ${fireAt} (${remaining})</span>
      </div>`
    }).join('')
  } else {
    timersEl.innerHTML = '<span class="dim">No active timers</span>'
  }

  // Active call
  const callCard = $('#call-card')
  if (s.activeCall) {
    callCard.style.display = ''
    const elapsed = timeSince(s.activeCall.startedAt)
    $('#call-info').innerHTML = `
      <div><strong>${esc(s.activeCall.tabTitle)}</strong></div>
      <div class="dim">${esc(s.activeCall.tabUrl || '')}</div>
      <div style="margin-top:6px">\ud83c\udf99 ${elapsed} \u00b7 ${s.activeCall.totalSegments} segments</div>
    `
  } else {
    callCard.style.display = 'none'
  }

  renderTickChart()
}

async function renderTickChart() {
  const ticks = await api('/api/ticks?limit=60')
  const chart = $('#tick-chart')
  if (ticks.length === 0) { chart.innerHTML = '<span class="dim">No ticks yet</span>'; return }

  const maxDuration = Math.max(...ticks.map(t => t.durationMs), 1)
  chart.innerHTML = ticks.reverse().map(t => {
    const h = Math.max(4, (t.durationMs / maxDuration) * 80)
    const tip = `#${t.tickNumber} ${t.status} ${t.durationMs}ms ${t.inputTokens}\u2192${t.outputTokens}tok`
    return `<div class="tick-bar ${t.status}" style="height:${h}px" title="${esc(tip)}">
      <div class="tick-bar-tip">${esc(tip)}</div>
    </div>`
  }).join('')
}

// ── Memory (state-preserving) ──
async function renderMemory() {
  const memories = await api('/api/memory')
  const list = $('#memory-list')

  // Build type filters (only once)
  const types = [...new Set(memories.map(m => m.type))].sort()
  const filtersEl = $('#memory-filters')
  if (filtersEl.children.length === 0) {
    filtersEl.innerHTML = `<button class="filter-pill active" data-type="">All</button>` +
      types.map(t => `<button class="filter-pill" data-type="${t}">${t}</button>`).join('')
    for (const pill of $$('.filter-pill', filtersEl)) {
      pill.addEventListener('click', () => {
        memoryTypeFilter = pill.dataset.type
        $$('.filter-pill', filtersEl).forEach(p => p.classList.toggle('active', p === pill))
        renderMemory()
      })
    }
    $('#memory-search').addEventListener('input', (e) => {
      memoryFilter = e.target.value.toLowerCase()
      renderMemory()
    })
  }

  const filtered = memories.filter(m => {
    if (memoryTypeFilter && m.type !== memoryTypeFilter) return false
    if (memoryFilter && !m.key.toLowerCase().includes(memoryFilter) && !m.summary.toLowerCase().includes(memoryFilter)) return false
    return true
  })

  list.innerHTML = filtered.map(m => `
    <div class="mem-item${expandedMemKeys.has(m.key) ? ' expanded' : ''}" data-key="${esc(m.key)}">
      <div class="mem-key">
        ${m.pinned ? '<span class="pin">\ud83d\udccc</span>' : ''}
        ${esc(m.key)}
        <span class="type-badge type-${m.type}">${m.type}</span>
      </div>
      <div class="mem-meta">v${m.version} \u00b7 ${m.accessCount} reads \u00b7 updated ${timeSince(m.updatedAt)} ago</div>
      <div class="mem-summary">${esc(m.summary)}</div>
      <div class="mem-value">${esc(m.value)}</div>
    </div>
  `).join('')

  for (const item of $$('.mem-item', list)) {
    item.addEventListener('click', () => {
      const key = item.dataset.key
      item.classList.toggle('expanded')
      if (item.classList.contains('expanded')) expandedMemKeys.add(key)
      else expandedMemKeys.delete(key)
    })
  }
}

// ── Activity ──
async function renderActivity() {
  const [ticks, inbox, outbox] = await Promise.all([
    api('/api/ticks?limit=30'),
    api('/api/inbox?limit=20'),
    api('/api/outbox?limit=20'),
  ])

  const items = []
  for (const t of ticks) {
    items.push({
      time: t.startedAt, icon: '\u26a1', cls: 'tick',
      html: `<strong>${statusLabel(t.status)}</strong> #${t.tickNumber} \u00b7 ${t.durationMs}ms \u00b7 ${t.inputTokens}\u2192${t.outputTokens} tok \u00b7 ${t.actions} actions${t.error ? ` <span style="color:var(--red)">${esc(t.error.slice(0, 80))}</span>` : ''}`,
    })
  }
  for (const i of inbox) {
    items.push({
      time: i.timestamp, icon: '\ud83d\udce9', cls: 'event',
      html: `${i.read ? '' : '<strong style="color:var(--yellow)">[unread]</strong> '}<strong>${esc(i.from.name)}</strong> <span class="dim">(${i.channel})</span><br>${esc(i.body.slice(0, 200))}`,
    })
  }
  for (const o of outbox) {
    const st = o.status === 'sent' ? '\u2714' : o.status === 'failed' ? '\u2718' : '\u25cf'
    items.push({
      time: o.createdAt, icon: '\ud83d\udce4', cls: 'send',
      html: `${st} \u2192 ${esc(o.to)} <span class="dim">(${o.channel})</span><br>${esc(o.content.slice(0, 200))}`,
    })
  }

  items.sort((a, b) => b.time.localeCompare(a.time))

  $('#activity-list').innerHTML = items.slice(0, 50).map(a => `
    <div class="act-item">
      <span class="act-time">${formatTime(a.time)}</span>
      <span class="act-icon">${a.icon}</span>
      <div class="act-body">${a.html}</div>
    </div>
  `).join('')
}

// ── Logs (SSE stream) ──
function setupLogs() {
  const output = $('#log-output')
  const scrollBtn = $('#log-scroll')
  const clearBtn = $('#log-clear')

  scrollBtn.addEventListener('click', () => {
    logAutoScroll = !logAutoScroll
    scrollBtn.classList.toggle('active', logAutoScroll)
  })
  clearBtn.addEventListener('click', () => { output.innerHTML = '' })

  output.addEventListener('scroll', () => {
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40
    if (!atBottom && logAutoScroll) { logAutoScroll = false; scrollBtn.classList.remove('active') }
  })
}

function connectLogs() {
  if (logEventSource) logEventSource.close()
  logEventSource = new EventSource('/logs')
  logEventSource.onmessage = (event) => appendLogLine(JSON.parse(event.data))
  logEventSource.onerror = () => setTimeout(connectLogs, 3000)
}

function appendLogLine(text) {
  const output = $('#log-output')
  const div = document.createElement('div')
  div.className = `log-line ${classifyLog(text)}`
  div.textContent = text
  output.appendChild(div)
  while (output.children.length > 2000) output.removeChild(output.firstChild)
  if (logAutoScroll) output.scrollTop = output.scrollHeight
}

function classifyLog(line) {
  if (line.includes('\u26a1') || line.includes('tick #')) return 'tick'
  if (line.includes('\ud83e\udde0') || /working|idle/i.test(line)) return 'llm'
  if (line.includes('\ud83d\udcbb') || line.includes('shell')) return 'shell'
  if (/error|failed|\u274c/i.test(line)) return 'error'
  if (line.includes('\ud83d\udce4') || /delivered|sent/i.test(line)) return 'send'
  if (line.includes('\ud83d\udcac') || line.includes('slack')) return 'event'
  return ''
}

// ── Prompt (state-preserving) ──
async function renderPrompt() {
  const p = await api('/api/prompt')
  const content = $('#prompt-content')

  const sections = [
    { title: 'System Prompt', body: p.systemPrompt },
    { title: `Memory Index (${p.memoryIndex.length} keys)`, body: p.memoryIndex.map(m => `${m.pinned ? '\ud83d\udccc ' : '  '}${m.key.padEnd(35)} ${m.summary}`).join('\n') },
    { title: `Hot Memory (${p.hotMemory.length} pinned)`, body: p.hotMemory.map(m => `[${m.key}] (v${m.version}, ${m.type})\n${m.value}`).join('\n\n') },
    { title: `Inbox (${p.inbox.length} unread)`, body: p.inbox.length ? p.inbox.map(i => `${i.channel} from ${i.from}: ${i.body}`).join('\n\n') : '(empty)' },
    { title: 'Scratchpad', body: p.scratchpad || '(empty)' },
  ]

  // Default: collapse System Prompt
  if (collapsedPromptSections.size === 0) collapsedPromptSections.add('System Prompt')

  content.innerHTML = sections.map(s => `
    <div class="prompt-section${collapsedPromptSections.has(s.title) ? ' collapsed' : ''}">
      <div class="prompt-section-header" data-title="${esc(s.title)}">
        <span class="arrow">\u25bc</span> ${esc(s.title)}
      </div>
      <div class="prompt-section-body">${esc(s.body)}</div>
    </div>
  `).join('')

  for (const header of $$('.prompt-section-header', content)) {
    header.addEventListener('click', () => {
      const title = header.dataset.title
      header.parentElement.classList.toggle('collapsed')
      if (header.parentElement.classList.contains('collapsed')) collapsedPromptSections.add(title)
      else collapsedPromptSections.delete(title)
    })
  }
}

// ── Usage Stats ──
async function renderUsage(status) {
  const ticks = await api('/api/ticks?limit=500')
  const container = $('#usage-content')

  const model = status.agent.model
  const totalIn = status.stats.tokensIn
  const totalOut = status.stats.tokensOut
  const totalCost = estimateCost(totalIn, totalOut, model)

  // Per-hour breakdown (last 24h)
  const now = Date.now()
  const hourBuckets = new Array(24).fill(null).map(() => ({ ticks: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 }))
  for (const t of ticks) {
    const hoursAgo = Math.floor((now - new Date(t.startedAt).getTime()) / 3600000)
    if (hoursAgo >= 0 && hoursAgo < 24) {
      const b = hourBuckets[23 - hoursAgo]
      b.ticks++
      b.tokensIn += t.inputTokens
      b.tokensOut += t.outputTokens
      b.durationMs += t.durationMs
    }
  }

  // Today's stats
  const todayStart = new Date(); todayStart.setHours(0,0,0,0)
  const todayTicks = ticks.filter(t => new Date(t.startedAt) >= todayStart)
  const todayIn = todayTicks.reduce((s,t) => s + t.inputTokens, 0)
  const todayOut = todayTicks.reduce((s,t) => s + t.outputTokens, 0)
  const todayCost = estimateCost(todayIn, todayOut, model)

  // By status
  const byStatus = {}
  for (const t of ticks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1
  }

  container.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-header">All Time</div>
        <div class="card-body">
          <div class="usage-stat"><span class="usage-label">Total ticks</span><span class="usage-val">${status.stats.totalTicks}</span></div>
          <div class="usage-stat"><span class="usage-label">Input tokens</span><span class="usage-val">${formatTokens(totalIn)}</span></div>
          <div class="usage-stat"><span class="usage-label">Output tokens</span><span class="usage-val">${formatTokens(totalOut)}</span></div>
          <div class="usage-stat"><span class="usage-label">Total tokens</span><span class="usage-val">${formatTokens(totalIn + totalOut)}</span></div>
          <div class="usage-stat cost"><span class="usage-label">Est. cost</span><span class="usage-val">$${totalCost.toFixed(2)}</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">Today</div>
        <div class="card-body">
          <div class="usage-stat"><span class="usage-label">Ticks</span><span class="usage-val">${todayTicks.length}</span></div>
          <div class="usage-stat"><span class="usage-label">Input tokens</span><span class="usage-val">${formatTokens(todayIn)}</span></div>
          <div class="usage-stat"><span class="usage-label">Output tokens</span><span class="usage-val">${formatTokens(todayOut)}</span></div>
          <div class="usage-stat cost"><span class="usage-label">Est. cost</span><span class="usage-val">$${todayCost.toFixed(2)}</span></div>
          <div class="usage-stat"><span class="usage-label">Avg tokens/tick</span><span class="usage-val">${todayTicks.length ? Math.round((todayIn + todayOut) / todayTicks.length) : 0}</span></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Last 24h \u2014 Tokens per Hour</div>
      <div class="usage-chart">
        ${hourBuckets.map((b, i) => {
          const h = Math.max(2, (b.tokensIn + b.tokensOut) / Math.max(1, ...hourBuckets.map(x => x.tokensIn + x.tokensOut)) * 60)
          const label = `${23-i}h ago: ${b.ticks} ticks, ${formatTokens(b.tokensIn + b.tokensOut)} tok`
          return `<div class="usage-bar" style="height:${h}px" title="${esc(label)}"></div>`
        }).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-header">Tick Status Distribution (last ${ticks.length})</div>
      <div class="card-body" style="display:flex;gap:16px;flex-wrap:wrap">
        ${Object.entries(byStatus).map(([s, n]) => `
          <div class="usage-stat"><span class="usage-label">${statusLabel(s)}</span><span class="usage-val">${n}</span></div>
        `).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-header">Pricing</div>
      <div class="card-body dim" style="font-size:11px">
        Model: ${esc(model)} \u00b7 Est. rate: $${(COST_PER_1M[model] || COST_PER_1M.default).toFixed(2)}/1M tokens (blended)
      </div>
    </div>
  `
}

// ── Inbox / Outbox (channel-categorized) ──
function setupInboxTabs() {
  for (const tab of $$('.inbox-tab')) {
    tab.addEventListener('click', () => {
      inboxSubTab = tab.dataset.sub
      $$('.inbox-tab').forEach(t => t.classList.toggle('active', t.dataset.sub === inboxSubTab))
      renderInbox()
    })
  }
}

async function renderInbox() {
  const [inbox, outbox] = await Promise.all([api('/api/inbox'), api('/api/outbox')])

  const inboxEl = $('#inbox-list')
  const outboxEl = $('#outbox-list')
  inboxEl.style.display = inboxSubTab === 'in' ? '' : 'none'
  outboxEl.style.display = inboxSubTab === 'out' ? '' : 'none'

  if (inboxSubTab === 'in') {
    // Group by channel
    const channels = [...new Set(inbox.map(i => i.channel))].sort()
    const filterBar = $('#inbox-channel-filter')
    filterBar.innerHTML = `<button class="filter-pill${!inboxChannelFilter ? ' active' : ''}" data-ch="">All</button>` +
      channels.map(ch => `<button class="filter-pill${inboxChannelFilter === ch ? ' active' : ''}" data-ch="${ch}">${channelIcon(ch)} ${ch}</button>`).join('')
    for (const pill of $$('.filter-pill', filterBar)) {
      pill.addEventListener('click', () => {
        inboxChannelFilter = pill.dataset.ch
        renderInbox()
      })
    }

    const filtered = inboxChannelFilter ? inbox.filter(i => i.channel === inboxChannelFilter) : inbox
    inboxEl.innerHTML = filtered.map(i => `
      <div class="msg-item ${i.read ? '' : 'unread'}">
        <div class="msg-header">
          <span>
            <span class="msg-channel-icon">${channelIcon(i.channel)}</span>
            <span class="msg-from">${esc(i.from.name)}</span>
            <span class="msg-channel">${i.channel}</span>
          </span>
          <span class="msg-time">${formatTime(i.timestamp)}</span>
        </div>
        <div class="msg-body">${esc(i.body)}</div>
      </div>
    `).join('') || '<div class="dim" style="padding:20px;text-align:center">No messages</div>'
  } else {
    outboxEl.innerHTML = outbox.map(o => `
      <div class="msg-item">
        <div class="msg-header">
          <span>
            <span class="msg-channel-icon">${channelIcon(o.channel)}</span>
            <span class="msg-from">\u2192 ${esc(o.to)}</span>
            <span class="msg-channel">${o.channel}</span>
            <span class="msg-status ${o.status}">${o.status}</span>
          </span>
          <span class="msg-time">${formatTime(o.createdAt)}</span>
        </div>
        <div class="msg-body">${esc(o.content)}</div>
        ${o.error ? `<div style="color:var(--red);font-size:11px;margin-top:4px">${esc(o.error)}</div>` : ''}
      </div>
    `).join('') || '<div class="dim" style="padding:20px;text-align:center">No messages</div>'
  }
}

function channelIcon(ch) {
  const icons = { slack: '\ud83d\udcac', gmail: '\ud83d\udce7', whatsapp: '\ud83d\udcf1', telegram: '\u2708\ufe0f' }
  return icons[ch] || '\ud83d\udce8'
}

// ── Helpers ──
function esc(s) {
  if (!s) return ''
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}

function timeSince(iso, future) {
  const ms = future ? new Date(iso).getTime() - Date.now() : Date.now() - new Date(iso).getTime()
  if (ms < 0) return future ? 'passed' : 'just now'
  if (ms < 1000) return 'now'
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`
  return `${Math.floor(ms / 86400000)}d`
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
  catch { return iso }
}

function formatTokens(n) {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n > 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function statusLabel(s) {
  const colors = { idle: 'var(--green)', working: 'var(--yellow)', blocked: 'var(--red)', done: 'var(--cyan)' }
  return `<span style="color:${colors[s] || 'inherit'}">${s}</span>`
}
