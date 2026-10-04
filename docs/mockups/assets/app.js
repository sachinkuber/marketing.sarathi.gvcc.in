/* Builds the shared screen frame around each mockup page, and the "Mockup controls"
   panel. Everything here is a prototype aid. Nothing on these screens is real data. */
(function () {
  'use strict'

  var I = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    inbox: '<path d="M3 13l3-8h12l3 8"/><path d="M3 13v6h18v-6h-5l-1 3H9l-1-3z"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    camp: '<path d="M4 14l12-8v12L4 14z"/><path d="M16 9h3a2 2 0 010 6h-3M7 15l1 5h3l-1-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    leads: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 5.5a3.2 3.2 0 010 6M18 14c2.2.6 3.5 2.4 3.5 5"/>',
    agents: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 7V4M9 12h.01M15 12h.01M9 15.5h6"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16l4-5 3 3 5-7"/>',
    bell: '<path d="M6 17V11a6 6 0 0112 0v6l2 2H4z"/><path d="M10 21h4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.6h4.4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/>'
  }
  function icon(name) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>'
  }
  window.mockIcon = icon

  // role -> which rail items it can reach
  var NAV = [
    { id: 'home', label: 'Home', href: 'home.html', icon: 'home', roles: 'owner admin approver viewer' },
    { id: 'inbox', label: 'Approval inbox', href: 'inbox.html', icon: 'inbox', count: '7', late: '2', roles: 'owner admin approver' },
    { id: 'calendar', label: 'Content calendar', href: 'calendar.html', icon: 'cal', roles: 'owner admin approver viewer' },
    { id: 'campaigns', label: 'Campaigns', href: 'campaigns.html', icon: 'camp', roles: 'owner admin approver viewer' },
    { id: 'visibility', label: 'Search and AI visibility', href: 'visibility.html', icon: 'search', roles: 'owner admin approver viewer' },
    { id: 'leads', label: 'Leads and pipeline', href: 'leads.html', icon: 'leads', roles: 'owner admin sales' },
    { id: 'agents', label: 'Agents', href: 'agents.html', icon: 'agents', roles: 'owner admin' },
    { id: 'reports', label: 'Reports', href: 'reports.html', icon: 'chart', roles: 'owner admin approver viewer' },
    { id: 'alerts', label: 'Alerts and incidents', href: 'alerts.html', icon: 'bell', count: '3', roles: 'owner admin' },
    { id: 'settings', label: 'Settings', href: 'settings.html', icon: 'gear', roles: 'owner admin' }
  ]
  var SUB = {
    settings: [
      ['settings', 'Brand', 'settings.html'], ['users', 'Users and roles', 'users.html'],
      ['approvals-settings', 'Approvals', 'approvals-settings.html'], ['safety', 'Kill switch and shadow mode', 'safety.html'],
      ['connections', 'Connected accounts', 'connections.html'], ['profile', 'Brand profile and facts', 'profile.html'],
      ['rules', 'Safety rules', 'rules.html'], ['answers', 'Approved answers', 'answers.html'],
      ['domains', 'Link domains', 'domains.html'], ['budgets', 'Budgets and costs', 'budgets.html'],
      ['data', 'Data', 'data.html'], ['audit', 'Audit log', 'audit.html']
    ],
    agents: [['agents', 'Agents', 'agents.html'], ['dead-letters', 'Dead letters', 'dead-letters.html'], ['actions', 'Unresolved actions', 'actions.html']],
    leads: [['leads', 'Pipeline', 'leads.html'], ['replies', 'Reply log', 'replies.html']]
  }
  var ROLES = { owner: 'Platform owner', admin: 'Brand admin', approver: 'Brand approver', sales: 'Sales contact', viewer: 'Viewer' }
  var WHO = { owner: ['Sachin Tripathi', 'ST'], admin: ['Brand admin (sample)', 'BA'], approver: ['Brand approver (sample)', 'AP'], sales: ['Sales contact (sample)', 'SC'], viewer: ['Viewer (sample)', 'VW'] }

  var state = { role: 'owner', late: true, shadow: false, kill: false, phone: false }
  try {
    var saved = JSON.parse(localStorage.getItem('mockState') || '{}')
    Object.keys(saved).forEach(function (k) { state[k] = saved[k] })
  } catch (e) { /* storage unavailable: defaults apply */ }
  function save() { try { localStorage.setItem('mockState', JSON.stringify(state)) } catch (e) { /* ignore */ } }

  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild }

  function shell() {
    var body = document.body
    var layout = body.dataset.layout || 'app'
    var main = document.getElementById('content')
    if (layout === 'app' && main) {
      var page = body.dataset.page
      var section = body.dataset.section
      var navId = body.dataset.nav || section || page
      var allowed = NAV.filter(function (n) { return n.roles.split(' ').indexOf(state.role) > -1 })
      var rail = '<nav class="rail" aria-label="Main">' +
        '<div class="logo">' + icon('film') + '<span>Marketing platform</span></div>' +
        '<button class="brandpick" type="button" onclick="location.href=\'brands.html\'" title="Switch brand"><span class="mark">AG</span><span><small>Brand</small><strong>Aztek Global</strong></span></button>' +
        '<div class="railnav">' + allowed.map(function (n) {
          var c = n.count ? '<span class="count' + (n.late && state.late ? ' late' : '') + '">' + (n.late && state.late ? n.late + ' late' : n.count) + '</span>' : ''
          return '<a href="' + n.href + '"' + (navId === n.id ? ' aria-current="page"' : '') + '>' + icon(n.icon) + '<span>' + n.label + '</span>' + c + '</a>'
        }).join('') + '</div>' +
        '<div class="foot"><b>' + WHO[state.role][0] + '</b>' + ROLES[state.role] + (state.role === 'owner' ? ' · sees all brands' : ' · one brand only') + '</div></nav>'

      var banners = ''
      if (state.kill) banners += '<div class="banner danger"><b>Kill switch is on for Aztek Global.</b> Waiting work is held and nothing is being sent.<a href="safety.html">Review and release</a></div>'
      if (state.shadow) banners += '<div class="banner info"><b>Shadow mode is on.</b> Everything is produced and approved as usual, and nothing is published.<a href="safety.html">Settings</a></div>'
      if (state.late && /owner|admin|approver/.test(state.role)) banners += '<div class="banner warn"><b>2 items are overdue for approval.</b> They stay unapproved and unpublished until someone decides.<a href="inbox.html?filter=overdue">Review overdue items</a></div>'

      var canStop = state.role === 'owner' || state.role === 'admin'
      var top = '<header class="topbar"><div class="where"><span>Aztek Global /</span> ' + (body.dataset.title || '') + '</div>' +
        '<span class="sample-tag" title="Every number, name and message on these screens is made up for the mockup">Sample data</span>' +
        '<div class="sp"></div>' +
        (canStop ? '<a class="stopbtn" href="safety.html" title="Stop activity for this brand">Stop</a>' : '') +
        '<button class="iconbtn" type="button" aria-label="Notifications">' + icon('bell') + '<span class="pip">3</span></button>' +
        '<div class="userchip"><span class="avatar">' + WHO[state.role][1] + '</span><span>' + WHO[state.role][0].split(' (')[0] + '</span></div></header>'

      var sub = ''
      if (section && SUB[section]) {
        sub = '<nav class="subnav" aria-label="Section">' + SUB[section].map(function (s) {
          return '<a href="' + s[2] + '"' + (page === s[0] ? ' aria-current="page"' : '') + '>' + s[1] + '</a>'
        }).join('') + '</nav>'
      }

      var app = el('<div class="app">' + rail + '<div class="col">' + top + '<div class="banners">' + banners + '</div></div></div>')
      var col = app.querySelector('.col')
      main.classList.add('page')
      if (sub) main.insertBefore(el(sub), main.firstChild)
      col.appendChild(main)
      body.insertBefore(app, body.firstChild)
    }
    if (state.phone) body.classList.add('phone')
    addControls()
    addPopup()
  }

  function addPopup() {
    var s = el('<div class="scrim" id="overdue-popup" role="dialog" aria-modal="true" aria-labelledby="od-h"><div class="modal">' +
      '<div class="mh"><h2 id="od-h">2 items are overdue for approval</h2><p class="muted small" style="margin-top:4px">Reminders were sent and the items were escalated. Nothing is approved or published until someone decides.</p></div>' +
      '<div class="mb"><ul class="od">' +
      '<li><span><b>Instagram post</b><br><span class="muted small">Why paint protection film is not a coating</span></span><span class="tag danger plain">Waiting 4 days</span></li>' +
      '<li><span><b>LinkedIn article</b><br><span class="muted small">What a certified studio does differently</span></span><span class="tag danger plain">Waiting 3 days</span></li>' +
      '</ul></div>' +
      '<div class="mf"><button class="btn" type="button" id="od-later">Later</button><a class="btn primary" href="inbox.html?filter=overdue">Review now</a></div></div></div>')
    document.body.appendChild(s)
    s.querySelector('#od-later').addEventListener('click', function () { s.classList.remove('open') })
    window.showOverduePopup = function () { s.classList.add('open'); s.querySelector('.btn.primary').focus() }
    if (new URLSearchParams(location.search).get('popup') === '1') window.showOverduePopup()
  }

  function addControls() {
    var c = el('<div class="mc"><button type="button" aria-expanded="false">Mockup controls</button><div class="box">' +
      '<div class="field"><label for="mc-role" class="small">Viewing as</label><select id="mc-role">' +
      Object.keys(ROLES).map(function (r) { return '<option value="' + r + '"' + (state.role === r ? ' selected' : '') + '>' + ROLES[r] + '</option>' }).join('') + '</select></div>' +
      '<label><input type="checkbox" id="mc-late"' + (state.late ? ' checked' : '') + '> Overdue banner and count</label>' +
      '<label><input type="checkbox" id="mc-kill"' + (state.kill ? ' checked' : '') + '> Kill switch is on</label>' +
      '<label><input type="checkbox" id="mc-shadow"' + (state.shadow ? ' checked' : '') + '> Shadow mode is on</label>' +
      '<label><input type="checkbox" id="mc-phone"' + (state.phone ? ' checked' : '') + '> Phone width</label>' +
      '<button class="btn sm" type="button" id="mc-pop">Show the overdue pop-up</button>' +
      '<p>Prototype aids only. They are not part of the product.</p></div></div>')
    document.body.appendChild(c)
    var btn = c.querySelector('button')
    btn.addEventListener('click', function () { c.classList.toggle('open'); btn.setAttribute('aria-expanded', c.classList.contains('open')) })
    function bind(id, key, isBool) {
      c.querySelector(id).addEventListener('change', function (e) { state[key] = isBool ? e.target.checked : e.target.value; save(); location.reload() })
    }
    bind('#mc-role', 'role', false); bind('#mc-late', 'late', true); bind('#mc-kill', 'kill', true)
    bind('#mc-shadow', 'shadow', true); bind('#mc-phone', 'phone', true)
    c.querySelector('#mc-pop').addEventListener('click', function () { window.showOverduePopup() })
  }

  window.mockState = state
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', shell)
  else shell()
})()
