/**
 * FILE: public/script/emolument-dashboard.js
 *
 * Drives the emolument dashboard (emolument-form.html).
 * Mirrors dashboard.js patterns exactly:
 *   - same sidebar toggle behaviour
 *   - same NavigationSystem (sections loaded from emolument-sections/)
 *   - same greeting / time logic
 *   - same inactivity timeout
 *
 * NAV RENDERING RULES:
 *   Everyone        → Dashboard, My Form
 *   Ship officer    → + My Ships (with assigned ships listed in panel)
 *   Any elevated    → + Progress
 *   EMOL_ADMIN      → + Admin Panel, + Role Management, + Form Cycle
 *   Always          → Logout
 *
 * Stats + Quick Access rendered per role combination.
 */

'use strict';

// ── Suppress logs in production ───────────────────────────
if (window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1') {
  console.log = () => {};
  console.debug = () => {};
}

// ══════════════════════════════════════════════════════════
// 1. TOKEN & CAPABILITY HELPERS
// ══════════════════════════════════════════════════════════

function getUser() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

function getCapabilities() {
  try {
    return JSON.parse(localStorage.getItem('capabilities') || '{}');
  } catch { return {}; }
}

const user = getUser();
const caps = getCapabilities();

// Guard — must be logged in
if (!user) window.location.href = 'personnel-user-login.html';

const emolRoles       = caps.emol_roles        || [];
const assignedShips   = caps.assigned_ships    || [];   // [{ship, role, scope_type, scope_value}]
const assignedCmds    = caps.assigned_commands || [];
const isEmolAdmin     = emolRoles.includes('EMOL_ADMIN');
const isShipOfficer   = emolRoles.some(r => ['DO','FO','CPO'].includes(r));
const hasElevatedRole = isEmolAdmin || isShipOfficer;

// ══════════════════════════════════════════════════════════
// 2. SIDEBAR TOGGLE  — identical to dashboard.js
// ══════════════════════════════════════════════════════════

const menuBtn   = document.getElementById('emol-menu-toggle');
const sidebarEl = document.getElementById('emol-sidebar');
let   sidebarOverlay = null;

function createSidebarOverlay() {
  if (sidebarOverlay) return sidebarOverlay;
  sidebarOverlay = document.createElement('div');
  sidebarOverlay.className = 'sidebar-overlay';
  sidebarOverlay.style.zIndex = '30';
  sidebarOverlay.addEventListener('click', closeSidebar);
  return sidebarOverlay;
}
function removeSidebarOverlay() {
  if (sidebarOverlay) { sidebarOverlay.remove(); sidebarOverlay = null; }
}
function closeSidebar() {
  if (window.innerWidth < 1024) {
    sidebarEl.classList.remove('sidebar-visible');
    removeSidebarOverlay();
    document.body.classList.remove('no-scroll');
  } else {
    sidebarEl.classList.add('desktop-hidden');
    document.body.classList.add('sidebar-closed');
    document.body.classList.remove('sidebar-open');
  }
}
function openSidebar() {
  if (window.innerWidth < 1024) {
    sidebarEl.classList.add('sidebar-visible');
    document.body.appendChild(createSidebarOverlay());
    document.body.classList.add('no-scroll');
  } else {
    sidebarEl.classList.remove('desktop-hidden');
    document.body.classList.add('sidebar-open');
    document.body.classList.remove('sidebar-closed');
  }
}
menuBtn?.addEventListener('click', () => {
  const isOpen = window.innerWidth < 1024
    ? sidebarEl.classList.contains('sidebar-visible')
    : !sidebarEl.classList.contains('desktop-hidden');
  isOpen ? closeSidebar() : openSidebar();
});

// ══════════════════════════════════════════════════════════
// 3. NAVIGATION SYSTEM  — mirrors dashboard.js NavigationSystem
// ══════════════════════════════════════════════════════════

const emolNav = (() => {
  let currentSection = null;
  let isNavigating   = false;
  const cache        = new Map();
  const history      = [];

  // Section base path
  const SECTION_PATH = 'emolument-sections/';

  function showLoadingState(name) {
    const main = document.getElementById('emol-main');
    if (!main) return;
    main.style.opacity = '0';
    main.style.transition = 'none';
    main.innerHTML = `
      <div class="mt-6">
        <h2 class="text-2xl lg:text-3xl font-bold text-navy mb-4">${name}</h2>
        <div class="bg-transparent rounded-xl shadow-sm border border-gray-100">
          <div class="flex items-center justify-center p-6">
            <div class="relative w-10 h-10 mr-3">
              <div class="absolute left-1 w-[6px] bg-blue-600 rounded animate-grow-up"></div>
              <div class="absolute right-1 w-[6px] bg-blue-600 rounded animate-grow-down"></div>
              <div class="absolute top-1/2 left-1 h-[6px] bg-blue-600 rounded animate-expand -translate-y-1/2"></div>
            </div>
            <span class="text-gray-600">Loading…</span>
          </div>
        </div>
      </div>`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      main.style.transition = 'opacity 0.2s ease';
      main.style.opacity = '1';
    }));
  }

  async function loadContent(sectionId) {
    if (cache.has(sectionId)) return cache.get(sectionId);
    try {
      const res = await fetch(`${SECTION_PATH}${sectionId}.html`);
      if (res.ok) {
        const html = await res.text();
        cache.set(sectionId, html);
        return html;
      }
    } catch {}
    return null;
  }

  function renderSection(name, content) {
    const main = document.getElementById('emol-main');
    if (!main) return;
    main.style.display = 'block';
    main.style.opacity = '0';
    main.innerHTML = `
      <div class="mt-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-2xl lg:text-3xl font-bold text-navy">${name}</h2>
        </div>
        <div class="bg-white/10 rounded-xl shadow-lg border border-gray-100">
          ${content || `
            <div class="text-center py-12">
              <i class="fas fa-tools text-4xl text-gray-300 mb-4"></i>
              <p class="text-gray-500">This section is under development.</p>
            </div>`}
        </div>
        <div class="my-6 flex items-center justify-between">
          <button onclick="emolNav.goBack()"
            class="bg-yellow-500 hover:bg-red-500 text-white font-medium px-6 py-2 rounded-lg
                   transition-colors duration-200 shadow-md hover:shadow-lg flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
            </svg>
            Return
          </button>
          <p class="text-navy font-bold text-[10px]">
            &copy; <span id="emol-year"></span>
            <a class="text-blue-500 font-bold hover:underline"
               href="https://hicadsystemsltd.com/" target="_blank">
              Hicad Systems Limited.
            </a>
            All rights reserved.
          </p>
        </div>
      </div>`;
    document.getElementById('emol-year').textContent = new Date().getFullYear();
    // Execute any inline scripts
    main.querySelectorAll('script').forEach(s => {
      const ns = document.createElement('script');
      ns.textContent = `(function(){\n${s.textContent}\n})();`;
      document.head.appendChild(ns);
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      main.style.transition = 'opacity 0.3s ease';
      main.style.opacity = '1';
    }));
  }

  async function go(sectionId, sectionName) {
    if (isNavigating) return;
    if (currentSection && currentSection !== sectionId) {
      history.push({ sectionId: currentSection, sectionName });
    }
    isNavigating = true;
    try {
      showLoadingState(sectionName);
      const content = await loadContent(sectionId);
      renderSection(sectionName, content);
      currentSection = sectionId;
      document.title = `NAVY Emolument — ${sectionName}`;
      window.history.pushState({ section: sectionName, sectionId }, '', `#${sectionId}`);
    } finally {
      isNavigating = false;
    }
  }

  function goBack() {
    if (history.length > 0) {
      const prev = history.pop();
      go(prev.sectionId, prev.sectionName);
    } else {
      returnHome();
    }
  }

  function returnHome() {
    currentSection = null;
    history.length = 0;
    document.title = 'NAVY Emolument';
    window.history.pushState({}, '', window.location.pathname);
    initDashboardHome();
  }

  return { go, goBack, returnHome };
})();

// ══════════════════════════════════════════════════════════
// 4. ROLE-ADAPTIVE CONFIG
// ══════════════════════════════════════════════════════════

// ── Stats per role ────────────────────────────────────────
const STAT_CONFIG = {
  EMOL_ADMIN: [
    { label: 'Total Personnel',  icon: 'fa-users',       iconColor: 'text-blue-600',  key: 'total'     },
    { label: 'Forms Submitted',  icon: 'fa-file-alt',    iconColor: 'text-green-600', key: 'submitted' },
    { label: 'Fully Confirmed',  icon: 'fa-check-circle',iconColor: 'text-yellow-500',key: 'confirmed' },
  ],
  DO: [
    { label: 'Awaiting My Review',icon: 'fa-inbox',      iconColor: 'text-blue-600',  key: 'pending'   },
    { label: 'Reviewed Today',   icon: 'fa-check',       iconColor: 'text-green-600', key: 'today'     },
    { label: 'Total on Ship',    icon: 'fa-users',       iconColor: 'text-yellow-500',key: 'total'     },
  ],
  FO: [
    { label: 'Awaiting Approval', icon: 'fa-inbox',      iconColor: 'text-blue-600',  key: 'pending'   },
    { label: 'Approved Today',   icon: 'fa-check-double',iconColor: 'text-green-600', key: 'today'     },
    { label: 'Total on Ship',    icon: 'fa-users',       iconColor: 'text-yellow-500',key: 'total'     },
  ],
  CPO: [
    { label: 'Pending Confirmation',icon:'fa-inbox',     iconColor: 'text-blue-600',  key: 'pending'   },
    { label: 'Confirmed Today',  icon: 'fa-check',       iconColor: 'text-green-600', key: 'today'     },
    { label: 'Command Total',    icon: 'fa-building',    iconColor: 'text-yellow-500',key: 'total'     },
  ],
  PERSONNEL: [
    { label: 'My Form Status',   icon: 'fa-file-alt',    iconColor: 'text-blue-600',  key: 'formStatus'},
    { label: 'Processing Year',  icon: 'fa-calendar-alt',iconColor: 'text-green-600', key: 'year'      },
    { label: 'Form Number',      icon: 'fa-hashtag',     iconColor: 'text-yellow-500',key: 'formNumber'},
  ],
};

// ── Quick access per role ─────────────────────────────────
const QUICK_CONFIG = {
  EMOL_ADMIN: [
    { icon: 'fa-toggle-on',    label: 'Open / Close Forms',    section: 'form-cycle',      name: 'Form Cycle'         },
    { icon: 'fa-user-shield',  label: 'Assign Roles',          section: 'role-management', name: 'Role Management'    },
    { icon: 'fa-chart-pie',    label: 'Progress Report',       section: 'progress-report', name: 'Progress Report'    },
    { icon: 'fa-ship',         label: 'Ships Overview',        section: 'ships-overview',  name: 'Ships Overview'     },
    { icon: 'fa-upload',       label: 'Bulk Approve',          section: 'admin-bulk',      name: 'Bulk Approve'       },
    { icon: 'fa-users-cog',    label: 'User Management',       section: 'user-management', name: 'User Management'    },
  ],
  DO: [
    { icon: 'fa-inbox',        label: 'Review Forms',          section: 'pending-review',  name: 'Pending Review'     },
    { icon: 'fa-eye',          label: 'Reviewed Forms',        section: 'reviewed-forms',  name: 'Reviewed Forms'     },
    { icon: 'fa-chart-bar',    label: 'Ship Progress',         section: 'progress-report', name: 'Progress Report'    },
    { icon: 'fa-user',         label: 'My Profile',            section: 'my-profile',      name: 'My Profile'         },
  ],
  FO: [
    { icon: 'fa-inbox',        label: 'Approve Forms',         section: 'pending-approval',name: 'Pending Approval'   },
    { icon: 'fa-check-double', label: 'Bulk Approve',          section: 'bulk-approve',    name: 'Bulk Approve'       },
    { icon: 'fa-chart-bar',    label: 'Ship Progress',         section: 'progress-report', name: 'Progress Report'    },
    { icon: 'fa-user',         label: 'My Profile',            section: 'my-profile',      name: 'My Profile'         },
  ],
  CPO: [
    { icon: 'fa-inbox',        label: 'Confirm Forms',         section: 'pending-confirm', name: 'Pending Confirmation'},
    { icon: 'fa-chart-bar',    label: 'Command Overview',      section: 'progress-report', name: 'Progress Report'    },
    { icon: 'fa-history',      label: 'Confirmed Records',     section: 'confirmed-forms', name: 'Confirmed Forms'    },
    { icon: 'fa-user',         label: 'My Profile',            section: 'my-profile',      name: 'My Profile'         },
  ],
  PERSONNEL: [
    { icon: 'fa-file-alt',     label: 'Fill My Form',          section: 'my-form',         name: 'My Emolument Form'  },
    { icon: 'fa-history',      label: 'Form History',          section: 'form-history',    name: 'Form History'       },
    { icon: 'fa-user',         label: 'My Profile',            section: 'my-profile',      name: 'My Profile'         },
  ],
};

// Determine primary display role (precedence: EMOL_ADMIN > CPO > FO > DO > PERSONNEL)
function getPrimaryRole() {
  if (isEmolAdmin) return 'EMOL_ADMIN';
  if (emolRoles.includes('CPO')) return 'CPO';
  if (emolRoles.includes('FO'))  return 'FO';
  if (emolRoles.includes('DO'))  return 'DO';
  return 'PERSONNEL';
}

const primaryRole = getPrimaryRole();

// ══════════════════════════════════════════════════════════
// 5. RENDER NAV ITEMS
// ══════════════════════════════════════════════════════════

function renderDynamicNavItems() {
  const container = document.getElementById('emol-dynamic-nav-items');
  if (!container) return;

  let html = '';

  // ── My Ships — ship officers only ────────────────────
  if (isShipOfficer && (assignedShips.length > 0 || assignedCmds.length > 0)) {
    // Build the submenu items from assigned ships + commands
    const shipItems = assignedShips.map(s => `
      <li>
        <a href="#"
           data-ship="${s.ship || s}"
           data-role="${s.role || ''}"
           class="block px-3 py-2 rounded hover:bg-amber-50 text-sm"
           onclick="openShipDashboard('${s.ship || s}', '${s.role || ''}'); return false;">
          <span class="flex items-center gap-2">
            <i class="fas fa-ship text-xs text-blue-500"></i>
            <span>${s.ship || s}</span>
            ${s.role ? `<span class="ml-auto text-[10px] font-bold uppercase
              px-1.5 py-0.5 rounded
              ${s.role==='DO' ? 'bg-blue-100 text-blue-700'
              : s.role==='FO' ? 'bg-amber-100 text-amber-700'
              : 'bg-green-100 text-green-700'}">${s.role}</span>` : ''}
          </span>
        </a>
      </li>`).join('');

    const cmdItems = assignedCmds.map(c => `
      <li>
        <a href="#"
           data-command="${c.command || c}"
           data-role="CPO"
           class="block px-3 py-2 rounded hover:bg-amber-50 text-sm"
           onclick="openShipDashboard('${c.command || c}', 'CPO'); return false;">
          <span class="flex items-center gap-2">
            <i class="fas fa-building text-xs text-green-500"></i>
            <span>${c.command || c}</span>
            <span class="ml-auto text-[10px] font-bold uppercase px-1.5 py-0.5 rounded
                         bg-green-100 text-green-700">CPO</span>
          </span>
        </a>
      </li>`).join('');

    html += `
      <li class="relative" data-menu="emol-ships">
        <a class="nav-item has-submenu flex items-center justify-between text-navy font-medium py-2 rounded px-2 hover:bg-amber-100/25"
           href="#" aria-expanded="false" role="button" tabindex="0">
          <span class="flex items-center gap-2">
            <i class="fas fa-ship"></i>
            <span>My Ships</span>
          </span>
          <img src="photos/rectangle54i339-1pu3.svg" alt=""
               class="w-2.5 h-1.5 ml-2 self-center transform transition-transform duration-200" />
        </a>
        <div class="submenu hidden opacity-0 invisible transition-all duration-150 rounded-lg p-4
                    shadow-lg border bg-white border-amber-100 z-50 text-sm cursor-pointer"
             style="position:absolute; left:100%; top:0; margin-left:3px; white-space:nowrap;">
          <ul class="space-y-1 m-0 p-0 list-none min-w-[180px]">
            ${shipItems}
            ${cmdItems}
          </ul>
        </div>
      </li>`;
  }

  // ── Progress — any elevated role ─────────────────────
  if (hasElevatedRole) {
    html += `
      <li class="relative">
        <a class="nav-item flex items-center justify-between text-navy font-medium py-2 rounded px-2 hover:bg-amber-100/25"
           href="#" onclick="emolNav.go('progress-report', 'Progress Report'); return false;">
          <span class="flex items-center gap-2">
            <i class="fas fa-chart-bar"></i>
            <span>Progress</span>
          </span>
        </a>
      </li>`;
  }

  // ── Admin Panel — EMOL_ADMIN only ────────────────────
  if (isEmolAdmin) {
    html += `
      <li class="relative" data-menu="emol-admin">
        <a class="nav-item has-submenu flex items-center justify-between text-navy font-medium py-2 rounded px-2 hover:bg-amber-100/25"
           href="#" aria-expanded="false" role="button" tabindex="0">
          <span class="flex items-center gap-2">
            <i class="fas fa-shield-alt"></i>
            <span>Admin Panel</span>
          </span>
          <img src="photos/rectangle54i339-1pu3.svg" alt=""
               class="w-2.5 h-1.5 ml-2 self-center transform transition-transform duration-200" />
        </a>
        <div class="submenu hidden opacity-0 invisible transition-all duration-150 rounded-lg p-4
                    shadow-lg border bg-white border-amber-100 z-50 text-sm cursor-pointer"
             style="position:absolute; left:100%; top:0; margin-left:3px; white-space:nowrap;">
          <ul class="space-y-2 m-0 p-0 list-none">
            <li><a href="#" data-section="form-cycle"
                   class="block px-3 py-1 rounded hover:bg-amber-50"
                   onclick="emolNav.go('form-cycle','Form Cycle'); return false;">
              Open / Close Forms
            </a></li>
            <li><a href="#" data-section="role-management"
                   class="block px-3 py-1 rounded hover:bg-amber-50"
                   onclick="emolNav.go('role-management','Role Management'); return false;">
              Role Management
            </a></li>
            <li><a href="#" data-section="ships-overview"
                   class="block px-3 py-1 rounded hover:bg-amber-50"
                   onclick="emolNav.go('ships-overview','Ships Overview'); return false;">
              Ships Overview
            </a></li>
            <li><a href="#" data-section="admin-bulk"
                   class="block px-3 py-1 rounded hover:bg-amber-50"
                   onclick="emolNav.go('admin-bulk','Bulk Approve'); return false;">
              Bulk Approve
            </a></li>
            <li><a href="#" data-section="user-management"
                   class="block px-3 py-1 rounded hover:bg-amber-50"
                   onclick="emolNav.go('user-management','User Management'); return false;">
              User Management
            </a></li>
          </ul>
        </div>
      </li>`;
  }

  container.innerHTML = html;

  // ── Wire up the submenu behaviour (same as dashboard.js) ─
  initSubmenuBehaviour();
}

// ══════════════════════════════════════════════════════════
// 6. SUBMENU BEHAVIOUR  — copy of dashboard.js logic
// ══════════════════════════════════════════════════════════

function initSubmenuBehaviour() {
  const submenuButtons = document.querySelectorAll('#emol-nav-list .has-submenu');
  let overlay = null;

  function createOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'emol-submenu-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0',
      background: 'rgba(0,0,0,0.5)', zIndex: 40, cursor: 'pointer',
    });
    overlay.addEventListener('click', closeAll);
    return overlay;
  }
  function removeOverlay() { if (overlay) overlay.remove(); }

  function positionSubmenu(btn, submenu) {
    const sidebar = document.getElementById('emol-sidebar');
    submenu.style.position = 'fixed';
    submenu.style.zIndex = 50;
    submenu.style.maxWidth = '320px';
    submenu.style.whiteSpace = 'nowrap';
    if (submenu.parentNode !== document.body) document.body.appendChild(submenu);
    const rect    = btn.getBoundingClientRect();
    const sRect   = sidebar?.getBoundingClientRect();
    const left    = sRect ? Math.round(sRect.right + 3) : 8;
    const top     = Math.max(8, Math.round(rect.top));
    submenu.style.left = `${left}px`;
    submenu.style.top  = `${top}px`;
  }

  function showSubmenu(btn, submenu, openedBy = 'hover') {
    btn.dataset.openedBy = openedBy;
    positionSubmenu(btn, submenu);
    submenu.classList.remove('opacity-0', 'invisible', 'hidden');
    submenu.classList.add('opacity-100', 'visible', 'block');
    btn.setAttribute('aria-expanded', 'true');
    btn.querySelector('img')?.classList.add('rotate-180');
    if (openedBy === 'click') {
      document.body.appendChild(createOverlay());
      document.body.classList.add('no-scroll');
    }
  }

  function hideSubmenu(btn, submenu) {
    if (btn.dataset.openedBy === 'click') {
      removeOverlay();
      document.body.classList.remove('no-scroll');
    }
    submenu.classList.add('opacity-0', 'invisible', 'hidden');
    submenu.classList.remove('opacity-100', 'visible', 'block');
    submenu.style.left = '';
    submenu.style.top  = '';
    btn.setAttribute('aria-expanded', 'false');
    btn.querySelector('img')?.classList.remove('rotate-180');
    delete btn.dataset.openedBy;
  }

  function closeAll() {
    submenuButtons.forEach(b => {
      const s = document.body.querySelector('.submenu.opacity-100');
      if (s) hideSubmenu(b, s);
    });
  }

  submenuButtons.forEach(btn => {
    const li      = btn.closest('li');
    const submenu = li?.querySelector('.submenu');
    if (!submenu) return;

    submenu.addEventListener('click', e => e.stopPropagation());

    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const isOpen    = btn.getAttribute('aria-expanded') === 'true';
      const openedBy  = btn.dataset.openedBy;
      if (isOpen && openedBy === 'hover') { btn.dataset.openedBy = 'click'; document.body.appendChild(createOverlay()); document.body.classList.add('no-scroll'); return; }
      if (isOpen && openedBy === 'click') { hideSubmenu(btn, submenu); return; }
      closeAll();
      showSubmenu(btn, submenu, 'click');
    });

    if (window.matchMedia('(hover: hover)').matches) {
      li.addEventListener('mouseenter', () => { if (btn.dataset.openedBy !== 'click') showSubmenu(btn, submenu, 'hover'); });
      const maybeClose = () => setTimeout(() => {
        if (btn.dataset.openedBy === 'click') return;
        if (!li.matches(':hover') && !submenu.matches(':hover')) hideSubmenu(btn, submenu);
      }, 200);
      li.addEventListener('mouseleave', maybeClose);
      submenu.addEventListener('mouseleave', maybeClose);
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.submenu') && !e.target.closest('.has-submenu')) closeAll();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
}

// ══════════════════════════════════════════════════════════
// 7. SHIPS PANEL  — right panel for ship officers on mobile
// ══════════════════════════════════════════════════════════

function renderShipsPanel() {
  const panel     = document.getElementById('emol-ships-panel');
  const list      = document.getElementById('emol-ships-list');
  const notifPanel = document.getElementById('emol-notifications');

  if (!isShipOfficer || (assignedShips.length === 0 && assignedCmds.length === 0)) {
    return; // stay hidden, show notifications instead
  }

  panel.classList.remove('hidden');
  notifPanel.classList.add('hidden'); // Ships panel replaces notifications for ship officers

  const allAssignments = [
    ...assignedShips.map(s => ({ name: s.ship || s, role: s.role || 'DO', type: 'SHIP' })),
    ...assignedCmds.map(c => ({ name: c.command || c, role: 'CPO', type: 'COMMAND' })),
  ];

  const roleBg = { DO:'bg-blue-100 text-blue-700', FO:'bg-amber-100 text-amber-700', CPO:'bg-green-100 text-green-700' };
  const roleIco = { DO:'fa-ship', FO:'fa-anchor', CPO:'fa-building' };

  list.innerHTML = allAssignments.map(a => `
    <li>
      <button
        onclick="openShipDashboard('${a.name}', '${a.role}')"
        class="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg
               hover:bg-amber-50 transition-colors group">
        <i class="fas ${roleIco[a.role] || 'fa-ship'} text-xs text-navy/40
                  group-hover:text-navy transition-colors"></i>
        <span class="flex-1 text-xs font-medium text-navy truncate">${a.name}</span>
        <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded
                     ${roleBg[a.role] || 'bg-gray-100 text-gray-600'}">
          ${a.role}
        </span>
      </button>
    </li>`).join('');
}

// ══════════════════════════════════════════════════════════
// 8. STATS
// ══════════════════════════════════════════════════════════

function renderStatLabels(role) {
  const config = STAT_CONFIG[role] || STAT_CONFIG.PERSONNEL;
  config.forEach((s, i) => {
    const n = i + 1;
    const label = document.getElementById(`emol-stat${n}-label`);
    const icon  = document.getElementById(`emol-stat${n}-icon`);
    if (label) label.textContent = s.label;
    if (icon)  icon.className = `fas ${s.icon} ${s.iconColor}`;
    icon && (icon.style.fontSize = '22px');
  });
}

async function loadStats() {
  const token = localStorage.getItem('token');
  try {
    const params = new URLSearchParams({ role: primaryRole });
    const res = await fetch(`/dashboard/stats?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();

    const map = { stat1: 'pending', stat2: 'today', stat3: 'total' };
    if (primaryRole === 'EMOL_ADMIN') {
      Object.assign(map, { stat1: 'total', stat2: 'submitted', stat3: 'confirmed' });
    }
    if (primaryRole === 'PERSONNEL') {
      document.getElementById('emol-stat1-value').textContent = data.formStatus || '—';
      document.getElementById('emol-stat2-value').textContent = data.year       || '—';
      document.getElementById('emol-stat3-value').textContent = data.formNumber || '—';
      return;
    }
    document.getElementById('emol-stat1-value').textContent = (data[map.stat1] ?? '—').toLocaleString?.() ?? data[map.stat1] ?? '—';
    document.getElementById('emol-stat2-value').textContent = (data[map.stat2] ?? '—').toLocaleString?.() ?? data[map.stat2] ?? '—';
    document.getElementById('emol-stat3-value').textContent = (data[map.stat3] ?? '—').toLocaleString?.() ?? data[map.stat3] ?? '—';
  } catch (err) {
    console.error('Stats error:', err);
  }
}

// ══════════════════════════════════════════════════════════
// 9. QUICK ACCESS GRID
// ══════════════════════════════════════════════════════════

function renderQuickAccess(role) {
  const grid = document.getElementById('emol-quick-grid');
  const meta = document.getElementById('emol-quick-meta');
  if (!grid) return;

  const items = QUICK_CONFIG[role] || QUICK_CONFIG.PERSONNEL;

  // Always include My Form for elevated roles too
  const hasMyForm = items.some(i => i.section === 'my-form');
  const allItems  = hasMyForm
    ? items
    : [{ icon:'fa-file-alt', label:'My Form', section:'my-form', name:'My Emolument Form' }, ...items];

  if (meta) meta.textContent = `${allItems.length} items`;

  grid.innerHTML = allItems.map(item => `
    <button
      onclick="emolNav.go('${item.section}', '${item.name}')"
      class="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/30
             hover:bg-amber-100/40 transition-all duration-200
             border border-amber-100/50 hover:border-amber-200
             shadow-sm hover:shadow-md active:scale-95">
      <div class="w-10 h-10 rounded-full bg-white/60 flex items-center justify-center
                  shadow-sm">
        <i class="fas ${item.icon} text-navy" style="font-size:18px"></i>
      </div>
      <span class="text-xs font-semibold text-navy text-center leading-tight">
        ${item.label}
      </span>
    </button>`).join('');
}

// ══════════════════════════════════════════════════════════
// 10. GREETING + TIME  — same as dashboard.js
// ══════════════════════════════════════════════════════════

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5  && h < 12) return 'Morning';
  if (h >= 12 && h < 16) return 'Afternoon';
  if (h >= 16 && h < 21) return 'Evening';
  return 'Night';
}

function updateGreeting() {
  const el = document.getElementById('emol-greeting');
  if (!el) return;
  const name = user?.full_name || user?.user_id || 'Officer';
  el.textContent = `Good ${getTimeOfDay()} ${name}, welcome to Emolument`;
}

function updateTime() {
  const el = document.getElementById('emol-time');
  if (!el) return;
  el.textContent = new Date().toLocaleString('en-US', {
    weekday:'long', year:'numeric', month:'long',
    day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit',
  });
}

// ══════════════════════════════════════════════════════════
// 11. PROCESSING YEAR
// ══════════════════════════════════════════════════════════

async function loadProcessingYear() {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/system/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('emol-processing-year');
    if (el && data.processingyear) el.textContent = data.processingyear;
  } catch {}
}

// ══════════════════════════════════════════════════════════
// 12. SHIP DASHBOARD — navigate to ship context
// ══════════════════════════════════════════════════════════

function openShipDashboard(shipOrCommand, role) {
  sessionStorage.setItem('active_ship',      shipOrCommand);
  sessionStorage.setItem('active_emol_role', role);
  // Ship dashboard is a separate page — built later
  window.location.href = `emolument-ship-dashboard.html`;
}

// ══════════════════════════════════════════════════════════
// 13. LOGOUT
// ══════════════════════════════════════════════════════════

async function emolLogout() {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {}
  // Preserve pre-login state (same pattern as dashboard.js)
  const pid          = sessionStorage.getItem('_pid');
  const preToken     = localStorage.getItem('pre_login_token');
  const userId       = localStorage.getItem('user_id');
  const fullName     = localStorage.getItem('full_name');
  const role         = localStorage.getItem('role');
  const cls          = localStorage.getItem('class');
  const capabilities = localStorage.getItem('capabilities');

  localStorage.clear();
  sessionStorage.clear();

  if (pid)          sessionStorage.setItem('_pid', pid);
  if (preToken)     { localStorage.setItem('token', preToken); localStorage.setItem('pre_login_token', preToken); }
  if (userId)       localStorage.setItem('user_id', userId);
  if (fullName)     localStorage.setItem('full_name', fullName);
  if (role)         localStorage.setItem('role', role);
  if (cls)          localStorage.setItem('class', cls);
  if (capabilities) localStorage.setItem('capabilities', capabilities);

  sessionStorage.setItem('_from_logout', 'true');
  window.location.href = 'user-dashboard.html';
}

// expose for inline HTML onclick
window.emolLogout       = emolLogout;
window.openShipDashboard = openShipDashboard;

// ══════════════════════════════════════════════════════════
// 14. INACTIVITY TIMEOUT  — same as dashboard.js
// ══════════════════════════════════════════════════════════

let inactivityTimer;
const INACTIVITY_TIME = 5 * 60 * 1000; // 5 minutes

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(emolLogout, INACTIVITY_TIME);
}

['mousedown','mousemove','keypress','scroll','touchstart','click'].forEach(evt => {
  document.addEventListener(evt, resetInactivityTimer, true);
});

// ══════════════════════════════════════════════════════════
// 15. INIT
// ══════════════════════════════════════════════════════════

function initDashboardHome() {
  const main = document.getElementById('emol-main');
  if (!main) return;

  // Re-show the original static main content
  // (navigateToSection replaces innerHTML — reload restores it)
  // For returnHome we just reload the dashboard content via location
  // Actually: since this file is loaded fresh, returnHome just resets state.
  // The original main HTML is already in the DOM from the HTML file.
  // We need to restore it — simplest is a soft reload of the main section.
  window.location.replace(window.location.pathname + window.location.search);
}

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar state (reuse saved preference key from payroll dashboard)
  const width = window.innerWidth;
  if (width >= 1200) {
    // load saved sidebar state
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/preferences/sidebar', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.success && data.sidebarCollapsed) {
          sidebarEl?.classList.add('desktop-hidden');
          document.body.classList.add('sidebar-closed');
          document.body.classList.remove('sidebar-open');
        } else {
          sidebarEl?.classList.remove('desktop-hidden');
          document.body.classList.add('sidebar-open');
          document.body.classList.remove('sidebar-closed');
        }
      } catch {}
    })();
  } else if (width >= 1024) {
    sidebarEl?.classList.add('desktop-hidden');
    document.body.classList.add('sidebar-closed');
  }

  // Build nav + UI
  renderDynamicNavItems();
  renderStatLabels(primaryRole);
  renderQuickAccess(primaryRole);
  renderShipsPanel();

  // Greeting + time
  updateGreeting();
  updateTime();
  setInterval(updateTime, 1000);
  setInterval(updateGreeting, 60000);

  // Load live data
  loadStats();
  loadProcessingYear();

  // Inactivity
  resetInactivityTimer();

  // Reveal
  requestAnimationFrame(() => {
    document.documentElement.classList.add('ready');
    document.body.classList.add('initialized');
  });
});

// Popstate — handle browser back
window.addEventListener('popstate', event => {
  if (event.state?.sectionId) {
    emolNav.go(event.state.sectionId, event.state.section);
  }
});