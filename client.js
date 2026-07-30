/* ==================================================================
   KONFIGURASI API (Vercel -> Apps Script)
   Ganti dengan Web App URL hasil Deploy Apps Script Anda, contoh:
   'https://script.google.com/macros/s/AKfycbzZeQqlCZkAFARWX9IxLeFG1xHN9CUBMmrdnyAF-kndY2tKN0Q51-ZCww3yYM0oydPnsQ/exec'
================================================================== */
const API_URL = 'https://script.google.com/macros/s/AKfycbzN835gI0WxjzIQB1-pZWz00DUSFkbQyn6gN7ZOsseLz-gPZu56dAFOtWZOoNDtIwrUUQ/exec';

// Semua komunikasi ke backend lewat sini. Pakai Content-Type text/plain
// (bukan application/json) supaya browser TIDAK mengirim preflight OPTIONS -
// Apps Script Web App tidak melayani OPTIONS, jadi request akan gagal jika kena preflight.
function callApi(fnName, args) {
  return fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fnName, args: args || [] })
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.error) throw new Error(res.error);
      return res.data;
    });
}

/* ==================================================================
   STATE GLOBAL
================================================================== */
let CURRENT_USER = null;
let MASTER = { kelas: [], mapel: [], guru: [], siswa: [] };
let SISWA_LOOKUPS = null;
let jurnalStep = 1;
let jurnalModalMode = 'guru';
let currentJadwalCtx = null;
let currentAbsensiData = [];
let currentKehadiran = 'Hadir';
let currentKehadiranFile = null;
let currentKehadiranExistingUrl = '';
let jadwalMappingKelas = null;
let jadwalMappingData = { Senin:[], Selasa:[], Rabu:[], Kamis:[], Jumat:[], Sabtu:[] };
let jadwalMappingHariAktif = 'Senin';
let piketMappingData = { Senin:[], Selasa:[], Rabu:[], Kamis:[], Jumat:[], Sabtu:[] };
let piketMappingHariAktif = 'Senin';
let _confirmDeleteCallback = null;

// cache data mentah untuk tabel-tabel yang tidak disimpan di MASTER
let USER_LIST = [];
let REKAP_WALI_LIST = [];
let PUBLIC_RECAP_LIST = [];
let PIKET_MAPPING_FLAT = [];
let REKAP_PIKET_KONF_LIST = [];
let REKAP_PIKET_GURU_LIST = [];
let STAT_SISWA_LIST = [];

const HARI_LIST = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
const STATUS_LIST = ['Hadir','Sakit','Izin','Alpa'];
const KEHADIRAN_GURU_LIST = ['Hadir','Sakit','Ijin','Alpha','Dinas Luar'];
const KEHADIRAN_COLORS = { 'Hadir':'#2FA36B', 'Sakit':'#F2A541', 'Ijin':'#3B82C4', 'Alpha':'#E15554', 'Dinas Luar':'#2F6E6A' };

/* ==================================================================
   INIT
================================================================== */
window.addEventListener('DOMContentLoaded', function () {
  const savedUser = sessionStorage.getItem('jk_user');
  loadMasterPublic();
  loadStatistikSiswaPublic();
  document.getElementById('pubFilterDate').value = todayStr();
  if (savedUser) {
    CURRENT_USER = JSON.parse(savedUser);
    showMainApp();
  }
});

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { return n < 10 ? '0' + n : n; }

/* ==================================================================
   TOAST
================================================================== */
function showToast(message, type) {
  type = type || 'success';
  const icons = { success: '✅', error: '⛔', warning: '⚠️', delete: '🗑️' };
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span>' + (icons[type] || '') + '</span><span>' + message + '</span><span class="close-t" onclick="this.parentElement.remove()">✕</span>';
  document.getElementById('toast-wrap').appendChild(el);
  setTimeout(function () { el.remove(); }, 4500);
}

function showLoading(show) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

function serverCall(fnName, args, onSuccess, silent) {
  if (!silent) showLoading(true);
  callApi(fnName, args)
    .then(function (data) { if (!silent) showLoading(false); onSuccess(data); })
    .catch(function (err) { if (!silent) showLoading(false); showToast('Terjadi kesalahan: ' + err.message, 'error'); });
}

/* ==================================================================
   MODAL HELPER
================================================================== */
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function bukaLink(inputId) {
  const val = document.getElementById(inputId).value.trim();
  if (!val) { showToast('Link belum diisi.', 'warning'); return; }
  window.open(val, '_blank');
}
// konversi link share Google Drive standar -> URL gambar yang bisa dirender <img>
function driveImageUrl(url) {
  if (!url) return '';
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : null;
  return id ? ('https://drive.google.com/uc?export=view&id=' + id) : url;
}

/* ==================================================================
   KONFIRMASI HAPUS (modal, bukan browser confirm())
================================================================== */
function confirmDelete(message, callback) {
  document.getElementById('confirmDeleteMsg').textContent = message;
  _confirmDeleteCallback = callback;
  openModal('confirmDeleteModal');
}
function runConfirmDelete() {
  closeModal('confirmDeleteModal');
  const cb = _confirmDeleteCallback;
  _confirmDeleteCallback = null;
  if (cb) cb();
}

/* ==================================================================
   MESIN TABEL: SEARCH + SORT + PAGINATION (dipakai semua tabel)
================================================================== */
let TABLE_STATE = {};
let TABLE_RENDERERS = {};

function getTableState(id) {
  if (!TABLE_STATE[id]) TABLE_STATE[id] = { query: '', sortKey: null, sortDir: 1, page: 1, pageSize: 8 };
  return TABLE_STATE[id];
}
function registerTableRenderer(id, fn) { TABLE_RENDERERS[id] = fn; }
function onTableSearchInput(id, value) { const st = getTableState(id); st.query = value; st.page = 1; if (TABLE_RENDERERS[id]) TABLE_RENDERERS[id](); }
function onTableSortClick(id, key) {
  const st = getTableState(id);
  if (st.sortKey === key) st.sortDir *= -1; else { st.sortKey = key; st.sortDir = 1; }
  if (TABLE_RENDERERS[id]) TABLE_RENDERERS[id]();
}
function onTablePage(id, page) { getTableState(id).page = page; if (TABLE_RENDERERS[id]) TABLE_RENDERERS[id](); }

// data: array asli: searchKeys: field yg dicocokkan pencarian
function applyTableProcessing(id, data, searchKeys) {
  const st = getTableState(id);
  let list = data || [];
  if (st.query) {
    const q = st.query.toLowerCase();
    list = list.filter(function (row) {
      return searchKeys.some(function (k) { return String(row[k] == null ? '' : row[k]).toLowerCase().indexOf(q) > -1; });
    });
  }
  list = list.slice();
  if (st.sortKey) {
    list.sort(function (a, b) {
      const va = a[st.sortKey], vb = b[st.sortKey];
      const na = isNaN(parseFloat(va)) || va === '' ? String(va || '').toLowerCase() : parseFloat(va);
      const nb = isNaN(parseFloat(vb)) || vb === '' ? String(vb || '').toLowerCase() : parseFloat(vb);
      if (na < nb) return -1 * st.sortDir;
      if (na > nb) return 1 * st.sortDir;
      return 0;
    });
  }
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / st.pageSize));
  if (st.page > totalPages) st.page = totalPages;
  const startIdx = (st.page - 1) * st.pageSize;
  return { pageData: list.slice(startIdx, startIdx + st.pageSize), total: total, totalPages: totalPages, page: st.page };
}

function renderPaginationControls(tableId, info) {
  const el = document.getElementById(tableId + '-pagination');
  if (!el) return;
  if (info.total === 0) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<button ' + (info.page <= 1 ? 'disabled' : '') + ' onclick="onTablePage(\'' + tableId + '\',' + (info.page - 1) + ')">‹ Prev</button>' +
    '<span class="info">Hal ' + info.page + '/' + info.totalPages + ' &middot; ' + info.total + ' data</span>' +
    '<button ' + (info.page >= info.totalPages ? 'disabled' : '') + ' onclick="onTablePage(\'' + tableId + '\',' + (info.page + 1) + ')">Next ›</button>';
}

function renderSortableHeaders(tableId) {
  const st = getTableState(tableId);
  document.querySelectorAll('#' + tableId + ' thead [data-key]').forEach(function (th) {
    const key = th.getAttribute('data-key');
    const baseLabel = th.getAttribute('data-label') || th.textContent.replace(/[▲▼]/g, '').trim();
    th.setAttribute('data-label', baseLabel);
    th.onclick = function () { onTableSortClick(tableId, key); };
    th.textContent = baseLabel + (st.sortKey === key ? (st.sortDir === 1 ? ' ▲' : ' ▼') : '');
  });
}

function emptyRow(cols) { return '<tr><td colspan="' + cols + '"><div class="empty-state">Belum ada data.</div></td></tr>'; }

/* ==================================================================
   SIDEBAR (mobile)
================================================================== */
function toggleSidebar(open) {
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebarOverlay').classList.toggle('show', open);
}

/* ==================================================================
   LOGIN / LOGOUT
================================================================== */
function openLoginModal() { openModal('loginModal'); document.getElementById('loginUsername').focus(); }

function doLogin() {
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  if (!u || !p) { showToast('Username dan password wajib diisi.', 'warning'); return; }
  const btn = document.getElementById('btnLoginSubmit');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Memproses...';
  callApi('authenticate', [u, p])
    .then(function (res) {
      btn.disabled = false; btn.innerHTML = 'Masuk';
      if (!res.success) { showToast(res.message, 'error'); return; }
      CURRENT_USER = res.user;
      sessionStorage.setItem('jk_user', JSON.stringify(CURRENT_USER));
      closeModal('loginModal');
      document.getElementById('loginUsername').value = '';
      document.getElementById('loginPassword').value = '';
      showToast('Selamat datang, ' + CURRENT_USER.nama + '!', 'success');
      showMainApp();
    })
    .catch(function (err) {
      btn.disabled = false; btn.innerHTML = 'Masuk';
      showToast('Gagal login: ' + err.message, 'error');
    });
}

function doLogout() {
  CURRENT_USER = null;
  sessionStorage.removeItem('jk_user');
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('publicPage').classList.remove('hidden');
  showToast('Anda telah keluar.', 'success');
}

/* ==================================================================
   MASTER DATA
================================================================== */
function loadMasterPublic() {
  serverCall('getKelas', [], function (res) {
    MASTER.kelas = res;
    fillSelect('pubFilterKelas', res.map(function(k){return k.NamaKelas;}), true, 'Semua Kelas');
    loadPublicRecap();
  }, true);
}

function fillSelect(id, values, withEmpty, emptyLabel) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = '';
  if (withEmpty) el.innerHTML += '<option value="">' + (emptyLabel || '-- pilih --') + '</option>';
  values.forEach(function (v) { el.innerHTML += '<option value="' + v + '">' + v + '</option>'; });
  if (values.includes(current)) el.value = current;
}
function fillDatalist(id, values) {
  document.getElementById(id).innerHTML = values.map(function (v) { return '<option value="' + v + '">'; }).join('');
}

/* ==================================================================
   STATISTIK SISWA PER KELAS (publik + dashboard)
================================================================== */
function loadStatistikSiswaPublic() {
  serverCall('getStatistikSiswaByKelas', [], function (res) {
    STAT_SISWA_LIST = res;
    registerTableRenderer('tblStatPublic', renderStatistikPublicTable);
    renderStatistikPublicTable();
  }, true);
}
function renderStatistikPublicTable() {
  const info = applyTableProcessing('tblStatPublic', STAT_SISWA_LIST, ['kelas', 'jurusan']);
  document.getElementById('statSiswaPublicBody').innerHTML = renderStatSiswaRows(info.pageData);
  renderSortableHeaders('tblStatPublic');
  renderPaginationControls('tblStatPublic', info);
}
function loadStatistikSiswaDashboard() {
  serverCall('getStatistikSiswaByKelas', [], function (res) {
    STAT_SISWA_LIST = res;
    registerTableRenderer('tblStatDashboard', renderStatistikDashboardTable);
    renderStatistikDashboardTable();
  }, true);
}
function renderStatistikDashboardTable() {
  const info = applyTableProcessing('tblStatDashboard', STAT_SISWA_LIST, ['kelas', 'jurusan']);
  document.getElementById('statSiswaDashboardBody').innerHTML = renderStatSiswaRows(info.pageData);
  renderSortableHeaders('tblStatDashboard');
  renderPaginationControls('tblStatDashboard', info);
}
function renderStatSiswaRows(list) {
  if (list.length === 0) return emptyRow(5);
  return list.map(function (s) {
    const pctL = s.total > 0 ? Math.round((s.lakiLaki / s.total) * 100) : 0;
    return '<tr><td>' + s.kelas + '</td><td>' + (s.jurusan || '-') + '</td><td>' + s.total + '</td>' +
      '<td>' + s.lakiLaki + '</td><td>' + s.perempuan +
      '<div class="gender-bar"><div class="l" style="width:' + pctL + '%"></div><div class="p" style="width:' + (100 - pctL) + '%"></div></div>' +
      '</td></tr>';
  }).join('');
}

/* ==================================================================
   HALAMAN PUBLIK: REKAP + FILTER + EXPORT
================================================================== */
function onPublicModeChange() {
  const mode = document.getElementById('pubFilterMode').value;
  document.getElementById('pubDateWrap').classList.toggle('hidden', mode !== 'harian');
  document.getElementById('pubRangeWrap').classList.toggle('hidden', mode === 'harian');
}
function publicFilterPayload() {
  const kelas = document.getElementById('pubFilterKelas').value;
  const mode = document.getElementById('pubFilterMode').value;
  return buildFilterPayload(kelas, mode, 'pubFilterDate', 'pubStartDate', 'pubEndDate');
}
function buildFilterPayload(kelas, mode, dateId, startId, endId) {
  const payload = { kelas: kelas };
  if (mode === 'harian') {
    payload.tanggal = document.getElementById(dateId).value || todayStr();
  } else {
    let start, end;
    const base = document.getElementById(dateId) ? document.getElementById(dateId).value : todayStr();
    if (mode === 'mingguan') {
      const d = new Date(base || todayStr());
      const day = d.getDay() === 0 ? 7 : d.getDay();
      start = new Date(d); start.setDate(d.getDate() - (day - 1));
      end = new Date(start); end.setDate(start.getDate() + 6);
    } else {
      const d = new Date(base || todayStr());
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }
    payload.startDate = fmt(start); payload.endDate = fmt(end);
  }
  return payload;
}
function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function loadPublicRecap() {
  serverCall('getPublicRecap', [publicFilterPayload()], function (res) {
    PUBLIC_RECAP_LIST = res;
    registerTableRenderer('tblPublicRecap', renderPublicRecapTable);
    renderPublicRecapTable();
  });
}
function renderPublicRecapTable() {
  const info = applyTableProcessing('tblPublicRecap', PUBLIC_RECAP_LIST, ['kelas', 'namaGuru', 'mapel', 'materi']);
  renderRekapTable('publicRecapBody', info.pageData, false, 12);
  renderSortableHeaders('tblPublicRecap');
  renderPaginationControls('tblPublicRecap', info);
}

function renderRekapTable(bodyId, list, withAction, colspan) {
  const body = document.getElementById(bodyId);
  if (!list || list.length === 0) {
    body.innerHTML = '<tr><td colspan="' + (colspan || 12) + '"><div class="empty-state"><div class="ic">📭</div>Belum ada data jurnal untuk filter ini.</div></td></tr>';
    return;
  }
  body.innerHTML = list.map(function (j) {
    return '<tr>' +
      '<td>' + j.tanggal + '</td><td>' + j.hari + '</td><td>' + j.kelas + '</td><td>' + j.jamKeLabel + '</td>' +
      '<td>' + j.namaGuru + '</td><td>' + j.mapel + '</td><td>' + (j.materi || '-') + '</td>' +
      '<td>' + j.rekapAbsen.Hadir + '</td><td>' + j.rekapAbsen.Sakit + '</td><td>' + j.rekapAbsen.Izin + '</td><td>' + j.rekapAbsen.Alpa + '</td>' +
      '<td>' + (j.keterangan || '-') +
      (withAction ? '</td><td><button class="btn btn-outline btn-sm" onclick=\'lihatDetailRekap(' + JSON.stringify(j).replace(/'/g, "&#39;") + ')\'>Detail</button></td>' : '</td>') +
      '</tr>';
  }).join('');
}

function lihatDetailRekap(j) {
  let rows = j.detailAbsensi.map(function (a) {
    return '<tr><td>' + a.nisn + '</td><td>' + a.nama + '</td><td>' + a.status + '</td><td>' + (a.catatan || '-') + '</td>' +
      '<td>' + (a.fotoUrl ? '<a href="' + a.fotoUrl + '" target="_blank">Lihat</a>' : '-') + '</td></tr>';
  }).join('');
  document.getElementById('detailRekapBody').innerHTML =
    '<div class="form-row"><div><label>Kelas</label><div class="readonly-box">' + j.kelas + '</div></div>' +
    '<div><label>Tanggal</label><div class="readonly-box">' + j.tanggal + ' (' + j.hari + ')</div></div></div>' +
    '<div class="form-row"><div><label>Guru</label><div class="readonly-box">' + j.namaGuru + ' <small style="color:var(--text-muted);">(' + (j.kehadiranGuru || 'Hadir') + ')</small></div></div>' +
    '<div><label>Mapel</label><div class="readonly-box">' + j.mapel + '</div></div></div>' +
    '<div class="field"><label>Materi</label><div class="readonly-box">' + (j.materi || '-') + '</div></div>' +
    '<div class="field"><label>Keterangan</label><div class="readonly-box">' + (j.keterangan || '-') + '</div></div>' +
    '<h4 style="margin:14px 0 8px;">Absensi Siswa</h4>' +
    '<div class="table-wrap"><table><thead><tr><th>NISN</th><th>Nama</th><th>Status</th><th>Catatan</th><th>Lampiran</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  openModal('detailRekapModal');
}

function exportExcel(filterPayload) {
  showLoading(true);
  callApi('exportRecapToExcel', [filterPayload])
    .then(function (res) {
      showLoading(false);
      const link = document.createElement('a');
      link.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + res.base64;
      link.download = res.filename;
      document.body.appendChild(link); link.click(); link.remove();
      showToast('File Excel berhasil diunduh.', 'success');
    })
    .catch(function (err) { showLoading(false); showToast('Gagal export: ' + err.message, 'error'); });
}

/* ==================================================================
   SETELAH LOGIN
================================================================== */
function showMainApp() {
  document.getElementById('publicPage').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('sbUserName').textContent = CURRENT_USER.nama;
  let roleLabel = CURRENT_USER.role;
  if (CURRENT_USER.isWaliKelas) roleLabel += ' • Wali Kelas';
  if (CURRENT_USER.isGuruPiket) roleLabel += ' • Guru Piket';
  document.getElementById('sbUserRole').textContent = roleLabel;

  buildNavMenu();
  loadAllMasterData();
  navigateTo('dashboard');
  document.getElementById('jurnalTanggal').value = todayStr();
  document.getElementById('piketTanggal').value = todayStr();
}

function buildNavMenu() {
  const items = [{ key: 'dashboard', label: 'Dashboard', ic: '📊' }];
  if (CURRENT_USER.role === 'Guru' || CURRENT_USER.role === 'Admin') items.push({ key: 'jurnal', label: 'Jurnal', ic: '📝' });
  if (CURRENT_USER.isWaliKelas || CURRENT_USER.role === 'Admin') items.push({ key: 'rekap', label: 'Rekap Jurnal Kelas', ic: '📚' });
  if (CURRENT_USER.isGuruPiket) items.push({ key: 'jurnalPiket', label: 'Jurnal Piket', ic: '🔔' });
  if (CURRENT_USER.isGuruPiket || CURRENT_USER.role === 'Admin') items.push({ key: 'rekapPiket', label: 'Rekap Jurnal Piket', ic: '📋' });
  if (CURRENT_USER.role === 'Admin' || CURRENT_USER.isWaliKelas) items.push({ key: 'siswa', label: 'Data Siswa', ic: '🎓' });
  if (CURRENT_USER.role === 'Admin') {
    items.push({ key: 'guru', label: 'Data Guru', ic: '👩‍🏫' });
    items.push({ key: 'mapel', label: 'Data Mata Pelajaran', ic: '📖' });
    items.push({ key: 'kelas', label: 'Data Kelas', ic: '🏫' });
    items.push({ key: 'jadwal', label: 'Mapping Jadwal', ic: '🗓️' });
    items.push({ key: 'piketMapping', label: 'Mapping Piket', ic: '🛎️' });
    items.push({ key: 'user', label: 'Manajemen User', ic: '🔐' });
  }
  document.getElementById('navMenu').innerHTML = items.map(function (it) {
    return '<div class="nav-item" id="nav-' + it.key + '" onclick="navigateTo(\'' + it.key + '\')"><span class="ic">' + it.ic + '</span>' + it.label + '</div>';
  }).join('');
}

function navigateTo(page) {
  document.querySelectorAll('.page-section').forEach(function (el) { el.classList.add('hidden'); });
  document.querySelectorAll('.nav-item').forEach(function (el) { el.classList.remove('active'); });
  document.getElementById('page-' + page).classList.remove('hidden');
  const nav = document.getElementById('nav-' + page); if (nav) nav.classList.add('active');
  toggleSidebar(false);

  if (page === 'dashboard') { loadDashboard(); loadStatistikSiswaDashboard(); }
  if (page === 'jurnal') loadJadwalGuru();
  if (page === 'rekap') { document.getElementById('rekapDate').value = todayStr(); loadRekapWaliKelas(); }
  if (page === 'piketMapping') loadPiketMappingTable();
  if (page === 'jurnalPiket') loadJurnalPiketPage();
  if (page === 'rekapPiket') { document.getElementById('rekapPiketDate').value = todayStr(); loadRekapPiket(); }
  if (page === 'siswa') loadSiswaTable();
  if (page === 'guru') loadGuruTable();
  if (page === 'mapel') loadMapelTable();
  if (page === 'kelas') loadKelasTable();
  if (page === 'jadwal') fillSelect('jadwalPilihKelas', MASTER.kelas.map(function(k){return k.NamaKelas;}), true, '-- pilih kelas --');
  if (page === 'user') loadUserTable();
}

function loadAllMasterData() {
  // FASE 1 OPTIMASI: dulu 3x round-trip (getKelas, getMapel, getGuru) -> sekarang 1x saja
  serverCall('getBootstrapData', [], function (r) {
    MASTER.kelas = r.kelas;
    MASTER.mapel = r.mapel;
    MASTER.guru = r.guru;
  }, true);
}

/* ==================================================================
   DASHBOARD
================================================================== */
function loadDashboard() {
  serverCall('getDashboardStats', [], function (res) {
    document.getElementById('statGuru').textContent = res.totalGuru;
    document.getElementById('statSiswa').textContent = res.totalSiswa;
    document.getElementById('statKelas').textContent = res.totalKelas;
    document.getElementById('statJurnalHariIni').textContent = res.jurnalHariIni;

    const max = Math.max.apply(null, res.trend7Hari.map(function (t) { return t.jumlah; }).concat([1]));
    document.getElementById('trendChart').innerHTML = res.trend7Hari.map(function (t) {
      const h = Math.max(6, Math.round((t.jumlah / max) * 130));
      const label = t.tanggal.slice(5);
      return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">' +
        '<div style="font-size:11px;font-weight:700;color:var(--navy);">' + t.jumlah + '</div>' +
        '<div style="width:100%;max-width:34px;height:' + h + 'px;background:linear-gradient(180deg,var(--teal),var(--navy));border-radius:6px 6px 0 0;"></div>' +
        '<div style="font-size:10.5px;color:var(--text-muted);">' + label + '</div></div>';
    }).join('');
  });
}

/* ==================================================================
   JURNAL: DAFTAR JADWAL GURU (CARD)
================================================================== */
function loadJadwalGuru() {
  const tanggal = document.getElementById('jurnalTanggal').value || todayStr();
  serverCall('getJadwalGuru', [CURRENT_USER.nip, tanggal], function (res) {
    const wrap = document.getElementById('jadwalGuruWrap');
    if (!res || res.length === 0) {
      wrap.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="ic">🗓️</div>Tidak ada jadwal mengajar pada tanggal ini.</div>';
      return;
    }
    wrap.innerHTML = res.map(function (j) {
      let badge = '<span class="badge pending">Belum diisi</span>';
      if (j.statusJurnal === 'Terisi') badge = '<span class="badge done">✓ Sudah diisi</span>';
      else if (j.statusJurnal === 'BelumLengkap') badge = '<span class="badge waiting" style="background:#FDE9D7;color:var(--amber);">⏳ Menunggu Piket</span>';
      return '<div class="jadwal-card" onclick="bukaModalJurnal(\'' + j.jadwalId + '\',\'' + tanggal + '\',\'guru\')">' +
        '<div class="jam">Jam ke-' + formatJamLabel(j.jamKeMulai, j.jamKeSelesai) + '</div>' +
        '<div class="kelas">' + j.kelas + '</div>' +
        '<div class="mapel">' + j.mapel + '</div>' +
        badge +
        '</div>';
    }).join('');
  });
}

function formatJamLabel(mulai, selesai) {
  mulai = Number(mulai); selesai = Number(selesai);
  return (selesai && selesai !== mulai) ? (mulai + '-' + selesai) : String(mulai);
}

/* ==================================================================
   MODAL ISI JURNAL (KEHADIRAN + MULTI STEP)
================================================================== */
function bukaModalJurnal(jadwalId, tanggal, mode) {
  jurnalModalMode = mode || 'guru';
  const guruInfoParam = (jurnalModalMode === 'guru') ? { nama: CURRENT_USER.nama } : null;

  serverCall('getJurnalDetail', [jadwalId, tanggal, guruInfoParam], function (res) {
    currentJadwalCtx = { jadwalId: jadwalId, tanggal: tanggal, jurnalId: res.jurnalId, identitas: res.identitas };
    document.getElementById('jurnalModalTitle').textContent = jurnalModalMode === 'piket'
      ? 'Lengkapi Jurnal - ' + res.identitas.kelas
      : 'Isi Jurnal Kelas';

    document.getElementById('jHari').textContent = res.identitas.hari;
    document.getElementById('jTanggal').textContent = res.identitas.tanggal;
    document.getElementById('jKelas').textContent = res.identitas.kelas;
    document.getElementById('jSemester').textContent = res.identitas.semester;
    document.getElementById('jJamKe').textContent = formatJamLabel(res.identitas.jamKeMulai, res.identitas.jamKeSelesai);
    document.getElementById('jMapel').textContent = res.identitas.mapel;
    document.getElementById('jGuru').textContent = res.identitas.namaGuru;
    document.getElementById('jMateri').value = res.materi || '';
    document.getElementById('jKeterangan').value = res.keterangan || '';
    currentAbsensiData = res.absensi.map(function (a) { return Object.assign({}, a); });
    renderAbsensiList();

    currentKehadiran = res.kehadiranGuru || 'Hadir';
    currentKehadiranFile = null;
    currentKehadiranExistingUrl = res.fileKehadiranURL || '';
    document.getElementById('kehadiranCatatan').value = res.catatanKehadiran || '';
    document.getElementById('kehadiranFileInput').value = '';
    renderKehadiranFileExisting();

    if (jurnalModalMode === 'piket') {
      document.getElementById('kehadiranCatatanReadonly').textContent = res.catatanKehadiran || '-';
      renderKehadiranFileReadonly(res.fileKehadiranURL);
    }

    jurnalStep = 1;
    updateStepUI();
    openModal('jurnalModal');
  });
}

function renderKehadiranFileExisting() {
  const wrap = document.getElementById('kehadiranFileExisting');
  wrap.innerHTML = currentKehadiranExistingUrl
    ? '<a href="' + currentKehadiranExistingUrl + '" target="_blank">📎 Lihat file yang sudah diupload</a>'
    : '';
}
function renderKehadiranFileReadonly(url) {
  document.getElementById('kehadiranFileReadonly').innerHTML = url
    ? '<a href="' + url + '" target="_blank">📄 Buka file tugas (PDF)</a>'
    : 'Tidak ada file yang diunggah.';
}

function renderKehadiranButtons() {
  const readonly = (jurnalModalMode === 'piket');
  document.getElementById('kehadiranButtons').innerHTML = KEHADIRAN_GURU_LIST.map(function (s) {
    const selected = (s === currentKehadiran);
    return '<button type="button" class="pill-btn' + (selected ? ' selected' : '') + '" style="--pill-c:' + KEHADIRAN_COLORS[s] + ';" ' +
      (readonly ? 'disabled' : 'onclick="pilihKehadiran(\'' + s + '\')"') + '>' + s + '</button>';
  }).join('');

  document.getElementById('kehadiranEditWrap').classList.toggle('hidden', readonly || currentKehadiran === 'Hadir');
  document.getElementById('kehadiranReadonlyWrap').classList.toggle('hidden', !readonly);
}

function pilihKehadiran(status) {
  currentKehadiran = status;
  renderKehadiranButtons();
  updateStepUI();
}

function handleKehadiranFileUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('File harus berformat PDF.', 'warning'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = function (e) {
    currentKehadiranFile = { base64: e.target.result.split(',')[1], nama: file.name };
    showToast('File tugas siap diunggah.', 'success');
  };
  reader.readAsDataURL(file);
}
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'kehadiranFileInput') handleKehadiranFileUpload(e.target);
});

function renderAbsensiList() {
  const wrap = document.getElementById('absensiList');
  if (currentAbsensiData.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="ic">🧑‍🎓</div>Belum ada data siswa untuk kelas ini.</div>';
    return;
  }
  wrap.innerHTML = currentAbsensiData.map(function (a, idx) {
    return '<div class="absen-row" data-idx="' + idx + '">' +
      '<div class="avatar-circle" style="width:28px;height:28px;font-size:11px;">' + (idx + 1) + '</div>' +
      '<div><b>' + a.nama + '</b><br><small style="color:var(--text-muted);">' + a.nisn + '</small></div>' +
      '<div class="status-pill">' + STATUS_LIST.map(function (s) {
        return '<button class="sel-' + s + (a.status === s ? ' selected' : '') + '" onclick="setAbsenStatus(' + idx + ',\'' + s + '\')">' + s + '</button>';
      }).join('') + '</div>' +
      '<div class="absen-note ' + (a.status !== 'Hadir' ? 'show' : '') + '" id="note-' + idx + '">' +
        '<div class="field"><label>Catatan</label><input type="text" value="' + (a.catatan || '') + '" oninput="updateCatatan(' + idx + ',this.value)" placeholder="Keterangan tambahan..."></div>' +
        '<div class="field"><label>Upload Bukti (Surat Sakit/Izin)</label><input type="file" accept="image/*,.pdf" onchange="handleFotoUpload(' + idx + ',this)">' +
        (a.fotoUrl ? '<div style="margin-top:6px;"><a href="' + a.fotoUrl + '" target="_blank">📎 Lihat lampiran saat ini</a></div>' : '') + '</div>' +
      '</div>' +
      '</div>';
  }).join('');
}

function setAbsenStatus(idx, status) { currentAbsensiData[idx].status = status; renderAbsensiList(); }
function updateCatatan(idx, val) { currentAbsensiData[idx].catatan = val; }
function setSemuaHadir() { currentAbsensiData.forEach(function (a) { a.status = 'Hadir'; a.catatan = ''; }); renderAbsensiList(); }

function handleFotoUpload(idx, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const base64 = e.target.result.split(',')[1];
    currentAbsensiData[idx].fotoBase64 = base64;
    currentAbsensiData[idx].fotoNama = file.name;
    currentAbsensiData[idx].fotoMime = file.type;
    showToast('Lampiran siap diunggah untuk ' + currentAbsensiData[idx].nama, 'success');
  };
  reader.readAsDataURL(file);
}

function isQuickAbsentFlow() { return jurnalModalMode === 'guru' && currentKehadiran !== 'Hadir'; }

function updateStepUI() {
  renderKehadiranButtons();
  for (let i = 1; i <= 5; i++) {
    document.getElementById('jStep-' + i).classList.toggle('hidden', i !== jurnalStep);
    const ind = document.getElementById('stepInd-' + i);
    ind.classList.remove('active', 'done');
    if (i === jurnalStep) ind.classList.add('active'); else if (i < jurnalStep) ind.classList.add('done');
  }
  const btnPrev = document.getElementById('btnPrevStep');
  const btnNext = document.getElementById('btnNextStep');
  const btnSimpanJurnal = document.getElementById('btnSimpanJurnal');
  const btnSimpanKehadiran = document.getElementById('btnSimpanKehadiran');
  btnPrev.classList.toggle('hidden', jurnalStep === 1);

  if (jurnalStep === 1 && isQuickAbsentFlow()) {
    btnNext.classList.add('hidden'); btnSimpanJurnal.classList.add('hidden'); btnSimpanKehadiran.classList.remove('hidden');
  } else if (jurnalStep < 5) {
    btnNext.classList.remove('hidden'); btnSimpanJurnal.classList.add('hidden'); btnSimpanKehadiran.classList.add('hidden');
  } else {
    btnNext.classList.add('hidden'); btnSimpanKehadiran.classList.add('hidden'); btnSimpanJurnal.classList.remove('hidden');
  }
}
function nextStep() { if (jurnalStep < 5) { jurnalStep++; updateStepUI(); } }
function prevStep() { if (jurnalStep > 1) { jurnalStep--; updateStepUI(); } }

function submitJurnal() {
  const quickAbsent = isQuickAbsentFlow();
  if (quickAbsent && !document.getElementById('kehadiranCatatan').value.trim()) {
    showToast('Catatan/titipan tugas wajib diisi.', 'warning'); return;
  }
  if (!quickAbsent && jurnalModalMode === 'guru' && currentKehadiran === 'Hadir' && !document.getElementById('jMateri').value.trim()) {
    showToast('Materi pembelajaran wajib diisi.', 'warning'); jurnalStep = 3; updateStepUI(); return;
  }

  const payload = {
    identitas: currentJadwalCtx.identitas,
    jurnalId: currentJadwalCtx.jurnalId,
    materi: document.getElementById('jMateri').value,
    keterangan: document.getElementById('jKeterangan').value,
    absensi: quickAbsent ? [] : currentAbsensiData,
    kehadiranGuru: currentKehadiran,
    catatanKehadiran: document.getElementById('kehadiranCatatan').value,
    fileKehadiranUrl: currentKehadiranExistingUrl,
    statusJurnal: quickAbsent ? 'BelumLengkap' : 'Terisi'
  };
  if (currentKehadiranFile) { payload.fileKehadiranBase64 = currentKehadiranFile.base64; payload.fileKehadiranNama = currentKehadiranFile.nama; }
  if (jurnalModalMode === 'piket') { payload.diisiOlehPiketNip = CURRENT_USER.nip; payload.diisiOlehPiketNama = CURRENT_USER.nama; }

  showLoading(true);
  callApi('saveJurnal', [payload])
    .then(function () {
      showLoading(false);
      showToast(quickAbsent ? 'Kehadiran & titipan tugas berhasil disimpan.' : 'Jurnal berhasil disimpan.', 'success');
      closeModal('jurnalModal');
      if (jurnalModalMode === 'piket') loadJurnalPiketPage(); else loadJadwalGuru();
    })
    .catch(function (err) { showLoading(false); showToast('Gagal menyimpan: ' + err.message, 'error'); });
}

/* ==================================================================
   REKAP JURNAL KELAS (WALI KELAS)
================================================================== */
function onRekapModeChange() {
  const mode = document.getElementById('rekapMode').value;
  document.getElementById('rekapDateWrap').classList.toggle('hidden', mode !== 'harian');
  document.getElementById('rekapRangeWrap').classList.toggle('hidden', mode === 'harian');
}
function rekapWaliFilterPayload() {
  const mode = document.getElementById('rekapMode').value;
  const kelas = CURRENT_USER.role === 'Admin' ? '' : CURRENT_USER.kelasWali;
  return buildFilterPayload(kelas, mode, 'rekapDate', 'rekapStart', 'rekapEnd');
}
function loadRekapWaliKelas() {
  document.getElementById('rekapSub').textContent = CURRENT_USER.isWaliKelas ?
    ('Rekap jurnal untuk kelas perwalian Anda: ' + CURRENT_USER.kelasWali) : 'Rekap jurnal seluruh kelas';
  serverCall('getRekapJurnal', [rekapWaliFilterPayload()], function (res) {
    REKAP_WALI_LIST = res;
    registerTableRenderer('tblRekapWali', renderRekapWaliTable);
    renderRekapWaliTable();
  });
}
function renderRekapWaliTable() {
  const info = applyTableProcessing('tblRekapWali', REKAP_WALI_LIST, ['namaGuru', 'mapel', 'materi']);
  renderRekapTable('rekapWaliBody', info.pageData, true, 12);
  renderSortableHeaders('tblRekapWali');
  renderPaginationControls('tblRekapWali', info);
}

/* ==================================================================
   MAPPING PIKET (ADMIN) - JamKe Mulai/Selesai
================================================================== */
function loadPiketMappingTable() {
  serverCall('getMappingPiket', [], function (res) {
    HARI_LIST.forEach(function (h) { piketMappingData[h] = []; });
    res.forEach(function (p) { piketMappingData[p.Hari].push({ jamKeMulai: p.JamKeMulai, jamKeSelesai: p.JamKeSelesai, nip: p.NIP_Guru, namaGuru: p.NamaGuru }); });

    const flat = [];
    HARI_LIST.forEach(function (h) {
      (piketMappingData[h] || []).sort(function (a, b) { return a.jamKeMulai - b.jamKeMulai; }).forEach(function (p) {
        flat.push({ hari: h, jamKeLabel: formatJamLabel(p.jamKeMulai, p.jamKeSelesai), namaGuru: p.namaGuru || p.nip });
      });
    });
    PIKET_MAPPING_FLAT = flat;
    registerTableRenderer('tblPiketMapping', renderPiketMappingTable);
    renderPiketMappingTable();
  });
}
function renderPiketMappingTable() {
  const info = applyTableProcessing('tblPiketMapping', PIKET_MAPPING_FLAT, ['hari', 'namaGuru']);
  document.getElementById('piketMappingBody').innerHTML = info.pageData.length === 0 ? emptyRow(3) : info.pageData.map(function (p) {
    return '<tr><td>' + p.hari + '</td><td>' + p.jamKeLabel + '</td><td>' + p.namaGuru + '</td></tr>';
  }).join('');
  renderSortableHeaders('tblPiketMapping');
  renderPaginationControls('tblPiketMapping', info);
}

function bukaModalMappingPiket() {
  piketMappingHariAktif = 'Senin';
  document.getElementById('hariTabsPiket').innerHTML = HARI_LIST.map(function (h) {
    return '<button class="tab-btn ' + (h === piketMappingHariAktif ? 'active' : '') + '" onclick="gantiTabHariPiket(\'' + h + '\')">' + h + '</button>';
  }).join('');
  renderHariContentPiket();
  openModal('piketModal');
}
function gantiTabHariPiket(hari) {
  piketMappingHariAktif = hari;
  document.querySelectorAll('#hariTabsPiket .tab-btn').forEach(function (b) { b.classList.toggle('active', b.textContent === hari); });
  renderHariContentPiket();
}
function renderHariContentPiket() {
  const list = piketMappingData[piketMappingHariAktif] || [];
  const guruOptions = MASTER.guru.map(function (g) { return '<option value="' + g.NIP + '">' + g.Nama + '</option>'; }).join('');
  let html = '';
  if (list.length === 0) html += '<div class="empty-state">Belum ada guru piket di hari ' + piketMappingHariAktif + '.</div>';
  list.forEach(function (row, idx) {
    html += '<div class="form-row" style="grid-template-columns:90px 90px 1fr 40px;align-items:end;">' +
      '<div class="field"><label>Jam Mulai</label><input type="number" min="1" value="' + row.jamKeMulai + '" onchange="ubahBarisPiket(' + idx + ',\'jamKeMulai\',this.value)"></div>' +
      '<div class="field"><label>Jam Selesai</label><input type="number" min="1" value="' + row.jamKeSelesai + '" onchange="ubahBarisPiket(' + idx + ',\'jamKeSelesai\',this.value)"></div>' +
      '<div class="field"><label>Guru Piket</label><select onchange="ubahBarisPiket(' + idx + ',\'nip\',this.value)">' + guruOptions.replace('value="' + row.nip + '"', 'value="' + row.nip + '" selected') + '</select></div>' +
      '<button class="btn btn-danger btn-sm" style="margin-bottom:14px;" onclick="hapusBarisPiket(' + idx + ')">✕</button>' +
      '</div>';
  });
  document.getElementById('hariContentPiket').innerHTML = html;
}
function tambahBarisPiket() {
  const list = piketMappingData[piketMappingHariAktif];
  const nextJam = list.length > 0 ? Math.max.apply(null, list.map(function (r) { return r.jamKeSelesai; })) + 1 : 1;
  list.push({ jamKeMulai: nextJam || 1, jamKeSelesai: nextJam || 1, nip: (MASTER.guru[0] || {}).NIP || '', namaGuru: (MASTER.guru[0] || {}).Nama || '' });
  renderHariContentPiket();
}
function ubahBarisPiket(idx, field, value) {
  const row = piketMappingData[piketMappingHariAktif][idx];
  row[field] = (field === 'jamKeMulai' || field === 'jamKeSelesai') ? parseInt(value, 10) : value;
  if (field === 'nip') { const g = MASTER.guru.find(function (x) { return x.NIP === value; }); row.namaGuru = g ? g.Nama : ''; }
}
function hapusBarisPiket(idx) {
  piketMappingData[piketMappingHariAktif].splice(idx, 1);
  renderHariContentPiket();
  showToast('Baris guru piket dihapus dari daftar (belum tersimpan).', 'delete');
}
function submitMappingPiket() {
  const flat = [];
  HARI_LIST.forEach(function (h) { (piketMappingData[h] || []).forEach(function (r) { flat.push({ hari: h, jamKeMulai: r.jamKeMulai, jamKeSelesai: r.jamKeSelesai, nip: r.nip, namaGuru: r.namaGuru }); }); });
  serverCall('saveMappingPiket', [flat], function () {
    showToast('Jadwal piket berhasil disimpan.', 'success');
    closeModal('piketModal');
    loadPiketMappingTable();
  });
}

/* ==================================================================
   JURNAL PIKET (GURU PIKET)
================================================================== */
let piketAssignedRangeHariIni = [];

function loadJurnalPiketPage() {
  const tanggal = document.getElementById('piketTanggal').value || todayStr();
  serverCall('getJadwalPiketGuru', [CURRENT_USER.nip, tanggal], function (rangeList) {
    piketAssignedRangeHariIni = rangeList;
    const adaJadwal = rangeList.length > 0;
    document.getElementById('piketTidakAdaJadwal').classList.toggle('hidden', adaJadwal);
    document.getElementById('piketKonfirmasiCard').classList.toggle('hidden', !adaJadwal);
    document.getElementById('piketDaftarWrap').classList.toggle('hidden', !adaJadwal);
    if (!adaJadwal) return;

    const labelJam = rangeList.map(function (r) { return formatJamLabel(r.mulai, r.selesai); }).join(', ');
    document.getElementById('piketKonfirmasiSub').textContent =
      'Jadwal piket Anda hari ini: Jam ke-' + labelJam + '. Geser untuk mengonfirmasi kehadiran.';

    serverCall('getPiketKonfirmasi', [CURRENT_USER.nip, tanggal], function (k) {
      document.getElementById('piketKonfirmasiSwitch').checked = k.konfirmasi;
      document.getElementById('piketCatatan').value = k.catatanPiket || '';
      document.getElementById('piketCatatanWrap').classList.toggle('hidden', !k.konfirmasi);
      if (k.konfirmasi) loadDaftarGuruTidakHadir(tanggal);
      else document.getElementById('piketCardWrap').innerHTML = '';
    }, true);
  });
}

function onToggleKonfirmasiPiket() {
  const tanggal = document.getElementById('piketTanggal').value || todayStr();
  const checked = document.getElementById('piketKonfirmasiSwitch').checked;
  const catatan = document.getElementById('piketCatatan').value;
  serverCall('savePiketKonfirmasi', [CURRENT_USER.nip, CURRENT_USER.nama, tanggal, checked, catatan], function () {
    document.getElementById('piketCatatanWrap').classList.toggle('hidden', !checked);
    showToast(checked ? 'Kehadiran piket dikonfirmasi.' : 'Konfirmasi piket dibatalkan.', 'success');
    if (checked) loadDaftarGuruTidakHadir(tanggal);
    else document.getElementById('piketCardWrap').innerHTML = '';
  });
}
function simpanCatatanPiket() {
  const tanggal = document.getElementById('piketTanggal').value || todayStr();
  const checked = document.getElementById('piketKonfirmasiSwitch').checked;
  const catatan = document.getElementById('piketCatatan').value;
  serverCall('savePiketKonfirmasi', [CURRENT_USER.nip, CURRENT_USER.nama, tanggal, checked, catatan], function () {
    showToast('Catatan piket tersimpan.', 'success');
  }, true);
}
function loadDaftarGuruTidakHadir(tanggal) {
  serverCall('getDaftarGuruTidakHadir', [tanggal, piketAssignedRangeHariIni], function (list) {
    const wrap = document.getElementById('piketCardWrap');
    if (!list || list.length === 0) {
      wrap.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><div class="ic">✅</div>Tidak ada guru yang berhalangan hadir pada jam piket Anda.</div>';
      return;
    }
    wrap.innerHTML = list.map(function (j) {
      const selesai = j.statusJurnal === 'Terisi';
      return '<div class="jadwal-card piket-card' + (selesai ? ' selesai' : '') + '" onclick="' + (selesai ? '' : "bukaModalJurnal('" + j.jadwalId + "','" + j.tanggal + "','piket')") + '">' +
        '<div class="jam">Jam ke-' + j.jamKeLabel + ' &middot; ' + j.kehadiranGuru + '</div>' +
        '<div class="kelas">' + j.kelas + '</div>' +
        '<div class="mapel">' + j.namaGuru + ' - ' + j.mapel + '</div>' +
        (selesai
          ? '<span class="badge done">✓ Selesai oleh ' + j.diisiOlehPiketNama + '</span>'
          : '<span class="badge waiting">⏳ Perlu dilengkapi</span>') +
        '</div>';
    }).join('');
  });
}

/* ==================================================================
   REKAP JURNAL PIKET
================================================================== */
function onRekapPiketModeChange() {
  const mode = document.getElementById('rekapPiketMode').value;
  document.getElementById('rekapPiketDateWrap').classList.toggle('hidden', mode !== 'harian');
  document.getElementById('rekapPiketRangeWrap').classList.toggle('hidden', mode === 'harian');
}
function rekapPiketFilterPayload() {
  const mode = document.getElementById('rekapPiketMode').value;
  return buildFilterPayload('', mode, 'rekapPiketDate', 'rekapPiketStart', 'rekapPiketEnd');
}
function loadRekapPiket() {
  serverCall('getRekapJurnalPiket', [rekapPiketFilterPayload()], function (res) {
    REKAP_PIKET_KONF_LIST = res.konfirmasi;
    REKAP_PIKET_GURU_LIST = res.guruTidakHadir;
    registerTableRenderer('tblRekapPiketKonf', renderRekapPiketKonfTable);
    registerTableRenderer('tblRekapPiketGuru', renderRekapPiketGuruTable);
    renderRekapPiketKonfTable();
    renderRekapPiketGuruTable();
  });
}
function renderRekapPiketKonfTable() {
  const info = applyTableProcessing('tblRekapPiketKonf', REKAP_PIKET_KONF_LIST, ['namaGuru']);
  document.getElementById('rekapPiketKonfirmasiBody').innerHTML = info.pageData.length === 0 ? emptyRow(4) : info.pageData.map(function (k) {
    return '<tr><td>' + k.tanggal + '</td><td>' + k.namaGuru + '</td><td>' +
      (k.konfirmasi ? '<span class="badge done">✓ Hadir</span>' : '<span class="badge pending">Belum Konfirmasi</span>') +
      '</td><td>' + (k.catatanPiket || '-') + '</td></tr>';
  }).join('');
  renderSortableHeaders('tblRekapPiketKonf');
  renderPaginationControls('tblRekapPiketKonf', info);
}
function renderRekapPiketGuruTable() {
  const info = applyTableProcessing('tblRekapPiketGuru', REKAP_PIKET_GURU_LIST, ['kelas', 'namaGuru', 'mapel']);
  document.getElementById('rekapPiketGuruBody').innerHTML = info.pageData.length === 0 ? emptyRow(9) : info.pageData.map(function (j) {
    return '<tr><td>' + j.tanggal + '</td><td>' + j.kelas + '</td><td>' + j.jamKeLabel + '</td><td>' + j.namaGuru + '</td><td>' + j.mapel + '</td>' +
      '<td>' + j.kehadiranGuru + '</td><td>' + (j.catatanKehadiran || '-') + '</td>' +
      '<td>' + (j.fileKehadiranURL ? '<a href="' + j.fileKehadiranURL + '" target="_blank">📄 Lihat</a>' : '-') + '</td>' +
      '<td>' + (j.diisiOlehPiketNama || (j.statusJurnal === 'Terisi' ? '-' : '⏳ Belum')) + '</td></tr>';
  }).join('');
  renderSortableHeaders('tblRekapPiketGuru');
  renderPaginationControls('tblRekapPiketGuru', info);
}
function exportRekapPiketExcel() {
  showLoading(true);
  callApi('exportRekapPiketToExcel', [rekapPiketFilterPayload()])
    .then(function (res) {
      showLoading(false);
      const link = document.createElement('a');
      link.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + res.base64;
      link.download = res.filename;
      document.body.appendChild(link); link.click(); link.remove();
      showToast('File Excel berhasil diunduh.', 'success');
    })
    .catch(function (err) { showLoading(false); showToast('Gagal export: ' + err.message, 'error'); });
}

/* ==================================================================
   CRUD: SISWA (biodata lengkap + scoping wali kelas + foto)
================================================================== */
function loadSiswaTable() {
  const isAdmin = CURRENT_USER.role === 'Admin';
  const kelasFilter = isAdmin ? '' : CURRENT_USER.kelasWali;
  document.getElementById('btnTambahSiswa').classList.toggle('hidden', !isAdmin);
  document.getElementById('siswaPageSub').textContent = isAdmin
    ? 'Kelola biodata lengkap siswa'
    : 'Data siswa kelas perwalian Anda: ' + (CURRENT_USER.kelasWali || '-') + ' (khusus lihat)';

  serverCall('getSiswa', [kelasFilter], function (res) {
    MASTER.siswa = res;
    registerTableRenderer('tblSiswa', renderSiswaTable);
    renderSiswaTable();
  });
}
function renderSiswaTable() {
  const isAdmin = CURRENT_USER.role === 'Admin';
  const info = applyTableProcessing('tblSiswa', MASTER.siswa, ['NISN', 'NIS_NIPD', 'Nama', 'Kelas', 'Jurusan']);
  document.getElementById('siswaBody').innerHTML = info.pageData.length === 0 ? emptyRow(8) : info.pageData.map(function (s) {
    return '<tr><td>' + s.NISN + '</td><td>' + (s.NIS_NIPD || '-') + '</td><td>' + s.Nama + '</td><td>' + s.Kelas + '</td><td>' + (s.Jurusan || '-') + '</td><td>' + (s.JenisKelamin || '-') + '</td><td>' + (s.NoHP || '-') + '</td>' +
      '<td>' +
      '<button class="btn btn-outline btn-sm" onclick="openSiswaDetail(\'' + s.NISN + '\')">Detail</button> ' +
      (isAdmin ? (
        '<button class="btn btn-outline btn-sm" onclick="openSiswaModal(\'' + s.NISN + '\')">Edit</button> ' +
        '<button class="btn btn-danger btn-sm btn-confirm-delete" onclick="hapusSiswa(\'' + s.NISN + '\')">Hapus</button>'
      ) : '') +
      '</td></tr>';
  }).join('');
  renderSortableHeaders('tblSiswa');
  renderPaginationControls('tblSiswa', info);
}
function cariSiswa(nisn) { return MASTER.siswa.find(function (s) { return String(s.NISN) === String(nisn); }); }

function ensureSiswaLookups(callback) {
  if (SISWA_LOOKUPS) { callback(); return; }
  serverCall('getSiswaFormLookups', [], function (res) { SISWA_LOOKUPS = res; callback(); }, true);
}

function switchSiswaTab(tabKey) {
  document.querySelectorAll('#siswaTabs .tab-btn').forEach(function (b) { b.classList.remove('active'); });
  document.querySelectorAll('.siswa-tab').forEach(function (el) { el.classList.add('hidden'); });
  document.getElementById('siswaTab-' + tabKey).classList.remove('hidden');
  Array.from(document.querySelectorAll('#siswaTabs .tab-btn')).forEach(function (b) {
    if (b.getAttribute('onclick').indexOf("'" + tabKey + "'") > -1) b.classList.add('active');
  });
}

function openSiswaModal(nisn) {
  const data = nisn ? cariSiswa(nisn) : null;
  document.getElementById('siswaModalTitle').textContent = data ? 'Edit Siswa - ' + data.Nama : 'Tambah Siswa';
  document.getElementById('siswaRow').value = data ? data._row : '';
  switchSiswaTab('identitas');

  fillSelect('siswaKelas', MASTER.kelas.map(function (k) { return k.NamaKelas; }), true, '-- pilih kelas --');

  ensureSiswaLookups(function () {
    fillSelect('siswaJenisKelamin', SISWA_LOOKUPS.jenisKelamin, true, '-- pilih --');
    fillSelect('siswaAgama', SISWA_LOOKUPS.agama, true, '-- pilih --');
    fillSelect('siswaStatusAnak', SISWA_LOOKUPS.statusAnak, true, '-- pilih --');
    fillSelect('siswaAnakKe', SISWA_LOOKUPS.anakKe, true, '-- pilih --');
    fillSelect('siswaJalurPendaftaran', SISWA_LOOKUPS.jalurPendaftaran, true, '-- pilih --');
    fillDatalist('dlKabKota', SISWA_LOOKUPS.kabupatenKota);
    fillDatalist('dlAsalSekolah', SISWA_LOOKUPS.asalSekolah);
    fillDatalist('dlKecamatan', []);
    fillDatalist('dlDesa', []);

    ['siswaNISN','siswaNISNIPD','siswaNama','siswaTempatLahir','siswaTanggalLahir','siswaNoHP','siswaFotoURL',
     'siswaKabKota','siswaKecamatan','siswaDesa','siswaRT','siswaRW','siswaAlamat','siswaAsalSekolah',
     'siswaNomorIjazah','siswaDiterimaTanggal','siswaNamaAyah','siswaPekerjaanAyah','siswaNamaIbu',
     'siswaPekerjaanIbu','siswaAlamatOrtu','siswaNoHPOrtu','siswaNamaWali','siswaPekerjaanWali',
     'siswaHubunganKeluarga','siswaAlamatWali','siswaNoHPWali','siswaAkta','siswaKartuKeluarga',
     'siswaIjazahFile','siswaSertifikatTKA','siswaSuratSehat'
    ].forEach(function (id) { document.getElementById(id).value = ''; });
    document.getElementById('siswaJenisKelamin').value = '';
    document.getElementById('siswaAgama').value = '';
    document.getElementById('siswaStatusAnak').value = '';
    document.getElementById('siswaAnakKe').value = '';
    document.getElementById('siswaJalurPendaftaran').value = '';
    document.getElementById('siswaJurusan').textContent = '-';
    document.getElementById('siswaNISN').disabled = false;

    if (data) {
      document.getElementById('siswaNISN').value = data.NISN || '';
      document.getElementById('siswaNISN').disabled = true;
      document.getElementById('siswaNISNIPD').value = data.NIS_NIPD || '';
      document.getElementById('siswaFotoURL').value = data.FotoURL || '';
      document.getElementById('siswaKelas').value = data.Kelas || '';
      onSiswaKelasChange();
      document.getElementById('siswaNama').value = data.Nama || '';
      document.getElementById('siswaTempatLahir').value = data.TempatLahir || '';
      document.getElementById('siswaTanggalLahir').value = data.TanggalLahir || '';
      document.getElementById('siswaJenisKelamin').value = data.JenisKelamin || '';
      document.getElementById('siswaAgama').value = data.Agama || '';
      document.getElementById('siswaStatusAnak').value = data.StatusAnak || '';
      document.getElementById('siswaAnakKe').value = data.AnakKe || '';
      document.getElementById('siswaNoHP').value = data.NoHP || '';

      document.getElementById('siswaKabKota').value = data.KabupatenKota || '';
      if (data.KabupatenKota) {
        serverCall('getDropdownList', ['Kecamatan', data.KabupatenKota], function (list) {
          fillDatalist('dlKecamatan', list);
          document.getElementById('siswaKecamatan').value = data.Kecamatan || '';
          if (data.Kecamatan) {
            serverCall('getDropdownList', ['DesaKelurahan', data.Kecamatan], function (list2) {
              fillDatalist('dlDesa', list2);
              document.getElementById('siswaDesa').value = data.DesaKelurahan || '';
            }, true);
          }
        }, true);
      }
      document.getElementById('siswaRT').value = data.RT || '';
      document.getElementById('siswaRW').value = data.RW || '';
      document.getElementById('siswaAlamat').value = data.Alamat || '';
      document.getElementById('siswaAsalSekolah').value = data.AsalSekolah || '';
      document.getElementById('siswaNomorIjazah').value = data.NomorIjazah || '';
      document.getElementById('siswaJalurPendaftaran').value = data.JalurPendaftaran || '';
      document.getElementById('siswaDiterimaTanggal').value = data.DiterimaTanggal || '';

      document.getElementById('siswaNamaAyah').value = data.NamaAyah || '';
      document.getElementById('siswaPekerjaanAyah').value = data.PekerjaanAyah || '';
      document.getElementById('siswaNamaIbu').value = data.NamaIbu || '';
      document.getElementById('siswaPekerjaanIbu').value = data.PekerjaanIbu || '';
      document.getElementById('siswaAlamatOrtu').value = data.AlamatOrtu || '';
      document.getElementById('siswaNoHPOrtu').value = data.NoHPOrtu || '';
      document.getElementById('siswaNamaWali').value = data.NamaWali || '';
      document.getElementById('siswaPekerjaanWali').value = data.PekerjaanWali || '';
      document.getElementById('siswaHubunganKeluarga').value = data.HubunganKeluarga || '';
      document.getElementById('siswaAlamatWali').value = data.AlamatWali || '';
      document.getElementById('siswaNoHPWali').value = data.NoHPWali || '';

      document.getElementById('siswaAkta').value = data.Akta || '';
      document.getElementById('siswaKartuKeluarga').value = data.KartuKeluarga || '';
      document.getElementById('siswaIjazahFile').value = data.IjazahFile || '';
      document.getElementById('siswaSertifikatTKA').value = data.SertifikatTKA || '';
      document.getElementById('siswaSuratSehat').value = data.SuratSehat || '';
    }

    openModal('siswaModal');
  });
}

function onSiswaKelasChange() {
  const nama = document.getElementById('siswaKelas').value;
  const k = MASTER.kelas.find(function (x) { return x.NamaKelas === nama; });
  document.getElementById('siswaJurusan').textContent = (k && k.Jurusan) ? k.Jurusan : '-';
}
function onKabKotaChange() {
  const val = document.getElementById('siswaKabKota').value;
  document.getElementById('siswaKecamatan').value = '';
  document.getElementById('siswaDesa').value = '';
  fillDatalist('dlDesa', []);
  if (!val) { fillDatalist('dlKecamatan', []); return; }
  serverCall('getDropdownList', ['Kecamatan', val], function (list) { fillDatalist('dlKecamatan', list); }, true);
}
function onKecamatanChange() {
  const val = document.getElementById('siswaKecamatan').value;
  document.getElementById('siswaDesa').value = '';
  if (!val) { fillDatalist('dlDesa', []); return; }
  serverCall('getDropdownList', ['DesaKelurahan', val], function (list) { fillDatalist('dlDesa', list); }, true);
}

function submitSiswa() {
  const kelas = document.getElementById('siswaKelas').value;
  const kObj = MASTER.kelas.find(function (x) { return x.NamaKelas === kelas; });
  const data = {
    _row: document.getElementById('siswaRow').value || null,
    NISN: document.getElementById('siswaNISN').value.trim(),
    NIS_NIPD: document.getElementById('siswaNISNIPD').value.trim(),
    FotoURL: document.getElementById('siswaFotoURL').value.trim(),
    Kelas: kelas,
    Jurusan: kObj ? (kObj.Jurusan || '') : '',
    Nama: document.getElementById('siswaNama').value.trim(),
    TempatLahir: document.getElementById('siswaTempatLahir').value.trim(),
    TanggalLahir: document.getElementById('siswaTanggalLahir').value,
    JenisKelamin: document.getElementById('siswaJenisKelamin').value,
    Agama: document.getElementById('siswaAgama').value,
    StatusAnak: document.getElementById('siswaStatusAnak').value,
    AnakKe: document.getElementById('siswaAnakKe').value,
    NoHP: document.getElementById('siswaNoHP').value.trim(),
    KabupatenKota: document.getElementById('siswaKabKota').value.trim(),
    Kecamatan: document.getElementById('siswaKecamatan').value.trim(),
    DesaKelurahan: document.getElementById('siswaDesa').value.trim(),
    RT: document.getElementById('siswaRT').value,
    RW: document.getElementById('siswaRW').value,
    Alamat: document.getElementById('siswaAlamat').value.trim(),
    AsalSekolah: document.getElementById('siswaAsalSekolah').value.trim(),
    NomorIjazah: document.getElementById('siswaNomorIjazah').value.trim(),
    JalurPendaftaran: document.getElementById('siswaJalurPendaftaran').value,
    DiterimaTanggal: document.getElementById('siswaDiterimaTanggal').value,
    NamaAyah: document.getElementById('siswaNamaAyah').value.trim(),
    PekerjaanAyah: document.getElementById('siswaPekerjaanAyah').value.trim(),
    NamaIbu: document.getElementById('siswaNamaIbu').value.trim(),
    PekerjaanIbu: document.getElementById('siswaPekerjaanIbu').value.trim(),
    AlamatOrtu: document.getElementById('siswaAlamatOrtu').value.trim(),
    NoHPOrtu: document.getElementById('siswaNoHPOrtu').value.trim(),
    NamaWali: document.getElementById('siswaNamaWali').value.trim(),
    PekerjaanWali: document.getElementById('siswaPekerjaanWali').value.trim(),
    HubunganKeluarga: document.getElementById('siswaHubunganKeluarga').value.trim(),
    AlamatWali: document.getElementById('siswaAlamatWali').value.trim(),
    NoHPWali: document.getElementById('siswaNoHPWali').value.trim(),
    Akta: document.getElementById('siswaAkta').value.trim(),
    KartuKeluarga: document.getElementById('siswaKartuKeluarga').value.trim(),
    IjazahFile: document.getElementById('siswaIjazahFile').value.trim(),
    SertifikatTKA: document.getElementById('siswaSertifikatTKA').value.trim(),
    SuratSehat: document.getElementById('siswaSuratSehat').value.trim()
  };
  if (!data.NISN || !data.Nama || !data.Kelas) {
    showToast('NISN, Nama, dan Kelas wajib diisi.', 'warning');
    switchSiswaTab('identitas');
    return;
  }
  serverCall('saveSiswa', [data], function () {
    showToast('Data siswa tersimpan.', 'success');
    closeModal('siswaModal');
    loadSiswaTable();
  });
}

function hapusSiswa(nisn) {
  confirmDelete('Yakin ingin menghapus data siswa ini? Tindakan ini tidak dapat dibatalkan.', function () {
    serverCall('deleteSiswa', [nisn], function () { showToast('Data siswa telah dihapus.', 'delete'); loadSiswaTable(); });
  });
}

function openSiswaDetail(nisn) {
  const s = cariSiswa(nisn);
  if (!s) return;
  function row(label, value) { return '<div class="di-label">' + label + '</div><div class="di-value">' + (value || '-') + '</div>'; }
  function fileRow(label, url) { return '<div class="di-label">' + label + '</div><div class="di-value">' + (url ? '<a href="' + url + '" target="_blank">🔗 Buka Berkas</a>' : '-') + '</div>'; }

  const fotoHtml = s.FotoURL
    ? '<div class="detail-photo-wrap"><img class="detail-photo" src="' + driveImageUrl(s.FotoURL) + '" onerror="this.outerHTML=\'<div class=&quot;detail-photo-placeholder&quot;>🧑‍🎓</div>\'"></div>'
    : '<div class="detail-photo-wrap"><div class="detail-photo-placeholder">🧑‍🎓</div></div>';

  const html = fotoHtml +
    '<div class="detail-section-title">Identitas</div><div class="detail-grid">' +
      row('NISN', s.NISN) + row('NIS/NIPD', s.NIS_NIPD) + row('Nama', s.Nama) + row('Kelas', s.Kelas) +
      row('Jurusan', s.Jurusan) + row('Tempat, Tgl Lahir', (s.TempatLahir || '-') + ', ' + (s.TanggalLahir || '-')) +
      row('Jenis Kelamin', s.JenisKelamin) + row('Agama', s.Agama) + row('Status Anak', s.StatusAnak) +
      row('Anak ke', s.AnakKe) + row('No HP', s.NoHP) +
    '</div>' +
    '<div class="detail-section-title">Alamat & Asal Sekolah</div><div class="detail-grid">' +
      row('Kabupaten/Kota', s.KabupatenKota) + row('Kecamatan', s.Kecamatan) + row('Desa/Kelurahan', s.DesaKelurahan) +
      row('RT/RW', (s.RT || '-') + ' / ' + (s.RW || '-')) + row('Alamat', s.Alamat) + row('Asal Sekolah', s.AsalSekolah) +
      row('Nomor Ijazah', s.NomorIjazah) + row('Jalur Pendaftaran', s.JalurPendaftaran) + row('Diterima Tanggal', s.DiterimaTanggal) +
    '</div>' +
    '<div class="detail-section-title">Orang Tua / Wali</div><div class="detail-grid">' +
      row('Nama Ayah', s.NamaAyah) + row('Pekerjaan Ayah', s.PekerjaanAyah) + row('Nama Ibu', s.NamaIbu) +
      row('Pekerjaan Ibu', s.PekerjaanIbu) + row('Alamat Orang Tua', s.AlamatOrtu) + row('No HP Orang Tua', s.NoHPOrtu) +
      row('Nama Wali', s.NamaWali) + row('Pekerjaan Wali', s.PekerjaanWali) + row('Hubungan Keluarga', s.HubunganKeluarga) +
      row('Alamat Wali', s.AlamatWali) + row('No HP Wali', s.NoHPWali) +
    '</div>' +
    '<div class="detail-section-title">Berkas</div><div class="detail-grid">' +
      fileRow('Akta Kelahiran', s.Akta) + fileRow('Kartu Keluarga', s.KartuKeluarga) + fileRow('Ijazah', s.IjazahFile) +
      fileRow('Sertifikat TKA', s.SertifikatTKA) + fileRow('Surat Keterangan Sehat', s.SuratSehat) +
    '</div>';
  document.getElementById('siswaDetailBody').innerHTML = html;
  openModal('siswaDetailModal');
}

/* ==================================================================
   CRUD: GURU
================================================================== */
function loadGuruTable() {
  serverCall('getGuru', [], function (res) {
    MASTER.guru = res;
    registerTableRenderer('tblGuru', renderGuruTable);
    renderGuruTable();
  });
}
function renderGuruTable() {
  const info = applyTableProcessing('tblGuru', MASTER.guru, ['NIP', 'Nama', 'MataPelajaran']);
  document.getElementById('guruBody').innerHTML = info.pageData.length === 0 ? emptyRow(4) : info.pageData.map(function (g) {
    return '<tr><td>' + g.NIP + '</td><td>' + g.Nama + '</td><td>' + g.MataPelajaran + '</td><td>' +
      '<button class="btn btn-outline btn-sm" onclick=\'openGuruModal(' + JSON.stringify(g).replace(/'/g, "&#39;") + ')\'>Edit</button> ' +
      '<button class="btn btn-danger btn-sm btn-confirm-delete" onclick="hapusGuru(\'' + g.NIP + '\')">Hapus</button></td></tr>';
  }).join('');
  renderSortableHeaders('tblGuru');
  renderPaginationControls('tblGuru', info);
}
function openGuruModal(data) {
  fillSelect('guruMapel', MASTER.mapel.map(function (m) { return m.NamaMapel; }));
  document.getElementById('guruModalTitle').textContent = data ? 'Edit Guru' : 'Tambah Guru';
  document.getElementById('guruRow').value = data ? data._row : '';
  document.getElementById('guruNIP').value = data ? data.NIP : '';
  document.getElementById('guruNIP').disabled = !!data;
  document.getElementById('guruNama').value = data ? data.Nama : '';
  if (data) {
    const list = String(data.MataPelajaran).split(',').map(function (s) { return s.trim(); });
    Array.from(document.getElementById('guruMapel').options).forEach(function (o) { o.selected = list.includes(o.value); });
  }
  openModal('guruModal');
}
function submitGuru() {
  const selected = Array.from(document.getElementById('guruMapel').selectedOptions).map(function (o) { return o.value; });
  const data = { _row: document.getElementById('guruRow').value || null, NIP: document.getElementById('guruNIP').value.trim(), Nama: document.getElementById('guruNama').value.trim(), MataPelajaran: selected };
  if (!data.NIP || !data.Nama || selected.length === 0) { showToast('Semua field wajib diisi.', 'warning'); return; }
  serverCall('saveGuru', [data], function () { showToast('Data guru tersimpan.', 'success'); closeModal('guruModal'); document.getElementById('guruNIP').disabled = false; loadGuruTable(); });
}
function hapusGuru(nip) {
  confirmDelete('Hapus data guru ini?', function () {
    serverCall('deleteGuru', [nip], function () { showToast('Data guru telah dihapus.', 'delete'); loadGuruTable(); });
  });
}

/* ==================================================================
   CRUD: MAPEL
================================================================== */
function loadMapelTable() {
  serverCall('getMapel', [], function (res) {
    MASTER.mapel = res;
    registerTableRenderer('tblMapel', renderMapelTable);
    renderMapelTable();
  });
}
function renderMapelTable() {
  const info = applyTableProcessing('tblMapel', MASTER.mapel, ['NamaMapel']);
  document.getElementById('mapelBody').innerHTML = info.pageData.length === 0 ? emptyRow(2) : info.pageData.map(function (m) {
    return '<tr><td>' + m.NamaMapel + '</td><td>' +
      '<button class="btn btn-outline btn-sm" onclick=\'openMapelModal(' + JSON.stringify(m).replace(/'/g, "&#39;") + ')\'>Edit</button> ' +
      '<button class="btn btn-danger btn-sm btn-confirm-delete" onclick="hapusMapel(\'' + m.NamaMapel + '\')">Hapus</button></td></tr>';
  }).join('');
  renderSortableHeaders('tblMapel');
  renderPaginationControls('tblMapel', info);
}
function openMapelModal(data) {
  document.getElementById('mapelModalTitle').textContent = data ? 'Edit Mata Pelajaran' : 'Tambah Mata Pelajaran';
  document.getElementById('mapelRow').value = data ? data._row : '';
  document.getElementById('mapelNama').value = data ? data.NamaMapel : '';
  openModal('mapelModal');
}
function submitMapel() {
  const nama = document.getElementById('mapelNama').value.trim();
  if (!nama) { showToast('Nama mata pelajaran wajib diisi.', 'warning'); return; }
  const data = { _row: document.getElementById('mapelRow').value || null, NamaMapel: nama };
  serverCall('saveMapel', [data], function () { showToast('Mata pelajaran tersimpan.', 'success'); closeModal('mapelModal'); loadMapelTable(); });
}
function hapusMapel(nama) {
  confirmDelete('Hapus mata pelajaran ini?', function () {
    serverCall('deleteMapel', [nama], function () { showToast('Mata pelajaran telah dihapus.', 'delete'); loadMapelTable(); });
  });
}

/* ==================================================================
   CRUD: KELAS (+ Jurusan)
================================================================== */
function loadKelasTable() {
  serverCall('getKelas', [], function (res) {
    MASTER.kelas = res;
    registerTableRenderer('tblKelas', renderKelasTable);
    renderKelasTable();
  });
}
function renderKelasTable() {
  const info = applyTableProcessing('tblKelas', MASTER.kelas, ['NamaKelas', 'Jurusan']);
  document.getElementById('kelasBody').innerHTML = info.pageData.length === 0 ? emptyRow(4) : info.pageData.map(function (k) {
    return '<tr><td>' + k.NamaKelas + '</td><td>' + (k.Tingkat || '-') + '</td><td>' + (k.Jurusan || '-') + '</td><td>' +
      '<button class="btn btn-outline btn-sm" onclick=\'openKelasModal(' + JSON.stringify(k).replace(/'/g, "&#39;") + ')\'>Edit</button> ' +
      '<button class="btn btn-danger btn-sm btn-confirm-delete" onclick="hapusKelas(\'' + k.NamaKelas + '\')">Hapus</button></td></tr>';
  }).join('');
  renderSortableHeaders('tblKelas');
  renderPaginationControls('tblKelas', info);
}
function openKelasModal(data) {
  document.getElementById('kelasModalTitle').textContent = data ? 'Edit Kelas' : 'Tambah Kelas';
  document.getElementById('kelasRow').value = data ? data._row : '';
  document.getElementById('kelasNama').value = data ? data.NamaKelas : '';
  document.getElementById('kelasTingkat').value = data ? data.Tingkat : '';
  document.getElementById('kelasJurusan').value = data ? data.Jurusan : '';
  openModal('kelasModal');
}
function submitKelas() {
  const nama = document.getElementById('kelasNama').value.trim();
  if (!nama) { showToast('Nama kelas wajib diisi.', 'warning'); return; }
  const data = {
    _row: document.getElementById('kelasRow').value || null,
    NamaKelas: nama,
    Tingkat: document.getElementById('kelasTingkat').value.trim(),
    Jurusan: document.getElementById('kelasJurusan').value.trim()
  };
  serverCall('saveKelas', [data], function () { showToast('Data kelas tersimpan.', 'success'); closeModal('kelasModal'); loadKelasTable(); });
}
function hapusKelas(nama) {
  confirmDelete('Hapus kelas ini? Data siswa/jadwal terkait tidak otomatis terhapus.', function () {
    serverCall('deleteKelas', [nama], function () { showToast('Data kelas telah dihapus.', 'delete'); loadKelasTable(); });
  });
}

/* ==================================================================
   CRUD: USER (+ Guru Piket)
================================================================== */
function loadUserTable() {
  serverCall('getUsers', [], function (res) {
    USER_LIST = res;
    registerTableRenderer('tblUser', renderUserTable);
    renderUserTable();
  });
}
function renderUserTable() {
  const info = applyTableProcessing('tblUser', USER_LIST, ['Username', 'Role', 'KelasWali']);
  document.getElementById('userBody').innerHTML = info.pageData.length === 0 ? emptyRow(6) : info.pageData.map(function (u) {
    const isPiket = u.IsGuruPiket === true || String(u.IsGuruPiket).toUpperCase() === 'TRUE';
    return '<tr><td>' + u.Username + '</td><td>' + u.Role + '</td><td>' + (u.NIP || '-') + '</td><td>' + (u.KelasWali || '-') + '</td>' +
      '<td>' + (isPiket ? '✅' : '-') + '</td><td>' +
      '<button class="btn btn-outline btn-sm" onclick=\'openUserModal(' + JSON.stringify(u).replace(/'/g, "&#39;") + ')\'>Edit</button> ' +
      '<button class="btn btn-danger btn-sm btn-confirm-delete" onclick="hapusUser(\'' + u.Username + '\')">Hapus</button></td></tr>';
  }).join('');
  renderSortableHeaders('tblUser');
  renderPaginationControls('tblUser', info);
}
function onUserRoleChange() {
  document.getElementById('userGuruWrap').classList.toggle('hidden', document.getElementById('userRole').value !== 'Guru');
  fillSelect('userNIP', MASTER.guru.map(function (g) { return g.NIP + ' - ' + g.Nama; }), true, '-- pilih guru --');
}
function onWaliKelasChange() {
  const checked = document.getElementById('userWaliKelas').checked;
  document.getElementById('userKelasWaliWrap').classList.toggle('hidden', !checked);
  if (checked) fillSelect('userKelasWali', MASTER.kelas.map(function (k) { return k.NamaKelas; }));
}
function openUserModal(data) {
  document.getElementById('userModalTitle').textContent = data ? 'Edit User' : 'Tambah User';
  document.getElementById('userRow').value = data ? data._row : '';
  document.getElementById('userUsername').value = data ? data.Username : '';
  document.getElementById('userUsername').disabled = !!data;
  document.getElementById('userPassword').value = data ? data.Password : '';
  document.getElementById('userRole').value = data ? data.Role : 'Admin';
  onUserRoleChange();
  if (data && data.NIP) document.getElementById('userNIP').value = data.NIP + ' - ' + (MASTER.guru.find(function(g){return g.NIP===data.NIP;})||{}).Nama;
  document.getElementById('userWaliKelas').checked = data ? (data.IsWaliKelas === true || String(data.IsWaliKelas).toUpperCase()==='TRUE') : false;
  onWaliKelasChange();
  if (data && data.KelasWali) document.getElementById('userKelasWali').value = data.KelasWali;
  document.getElementById('userGuruPiket').checked = data ? (data.IsGuruPiket === true || String(data.IsGuruPiket).toUpperCase()==='TRUE') : false;
  openModal('userModal');
}
function submitUser() {
  const role = document.getElementById('userRole').value;
  const nipRaw = document.getElementById('userNIP').value;
  const nip = role === 'Guru' ? nipRaw.split(' - ')[0] : '';
  const data = {
    _row: document.getElementById('userRow').value || null,
    Username: document.getElementById('userUsername').value.trim(),
    Password: document.getElementById('userPassword').value,
    Role: role,
    NIP: nip,
    IsWaliKelas: role === 'Guru' ? document.getElementById('userWaliKelas').checked : false,
    KelasWali: (role === 'Guru' && document.getElementById('userWaliKelas').checked) ? document.getElementById('userKelasWali').value : '',
    IsGuruPiket: role === 'Guru' ? document.getElementById('userGuruPiket').checked : false
  };
  if (!data.Username || !data.Password) { showToast('Username dan password wajib diisi.', 'warning'); return; }
  if (role === 'Guru' && !nip) { showToast('Pilih data guru terlebih dahulu.', 'warning'); return; }
  serverCall('saveUser', [data], function () { showToast('User tersimpan.', 'success'); closeModal('userModal'); document.getElementById('userUsername').disabled = false; loadUserTable(); });
}
function hapusUser(username) {
  confirmDelete('Hapus user ini?', function () {
    serverCall('deleteUser', [username], function () { showToast('User telah dihapus.', 'delete'); loadUserTable(); });
  });
}

/* ==================================================================
   MAPPING JADWAL (PER KELAS) - JamKe Mulai/Selesai
================================================================== */
function openMappingJadwal() {
  const kelas = document.getElementById('jadwalPilihKelas').value;
  if (!kelas) { document.getElementById('jadwalKelasPreview').innerHTML = ''; return; }
  jadwalMappingKelas = kelas;
  serverCall('getJadwalByKelas', [kelas], function (res) {
    HARI_LIST.forEach(function (h) { jadwalMappingData[h] = []; });
    res.forEach(function (j) { jadwalMappingData[j.Hari].push({ jamKeMulai: j.JamKeMulai, jamKeSelesai: j.JamKeSelesai, mapel: j.Mapel, nip: j.NIP_Guru, namaGuru: j.NamaGuru }); });
    renderJadwalPreview();
  });
}
function renderJadwalPreview() {
  const wrap = document.getElementById('jadwalKelasPreview');
  let html = '<div class="card"><h3 style="margin-bottom:12px;">Jadwal Kelas ' + jadwalMappingKelas + '</h3>';
  html += '<button class="btn btn-amber btn-sm" onclick="bukaModalMappingJadwal()">✏️ Atur Jadwal</button>';
  html += '<div class="table-wrap" style="margin-top:14px;"><table><thead><tr><th>Hari</th><th>Jam Ke</th><th>Mata Pelajaran</th><th>Guru</th></tr></thead><tbody>';
  let any = false;
  HARI_LIST.forEach(function (h) {
    (jadwalMappingData[h] || []).sort(function(a,b){return a.jamKeMulai-b.jamKeMulai;}).forEach(function (j) {
      any = true;
      html += '<tr><td>' + h + '</td><td>' + formatJamLabel(j.jamKeMulai, j.jamKeSelesai) + '</td><td>' + j.mapel + '</td><td>' + (j.namaGuru || j.nip) + '</td></tr>';
    });
  });
  if (!any) html += '<tr><td colspan="4"><div class="empty-state">Belum ada jadwal untuk kelas ini.</div></td></tr>';
  html += '</tbody></table></div></div>';
  wrap.innerHTML = html;
}

function bukaModalMappingJadwal() {
  jadwalMappingHariAktif = 'Senin';
  document.getElementById('jadwalModalTitle').textContent = 'Atur Jadwal - ' + jadwalMappingKelas;
  document.getElementById('hariTabs').innerHTML = HARI_LIST.map(function (h) {
    return '<button class="tab-btn ' + (h === jadwalMappingHariAktif ? 'active' : '') + '" onclick="gantiTabHari(\'' + h + '\')">' + h + '</button>';
  }).join('');
  renderHariContent();
  openModal('jadwalModal');
}
function gantiTabHari(hari) {
  jadwalMappingHariAktif = hari;
  document.querySelectorAll('#hariTabs .tab-btn').forEach(function (b) { b.classList.toggle('active', b.textContent === hari); });
  renderHariContent();
}
function renderHariContent() {
  const list = jadwalMappingData[jadwalMappingHariAktif] || [];
  const mapelOptions = MASTER.mapel.map(function (m) { return '<option value="' + m.NamaMapel + '">' + m.NamaMapel + '</option>'; }).join('');
  const guruOptions = MASTER.guru.map(function (g) { return '<option value="' + g.NIP + '">' + g.Nama + '</option>'; }).join('');
  let html = '';
  if (list.length === 0) html += '<div class="empty-state">Belum ada jam pelajaran di hari ' + jadwalMappingHariAktif + '.</div>';
  list.forEach(function (row, idx) {
    html += '<div class="form-row" style="grid-template-columns:80px 80px 1fr 1fr 40px;align-items:end;">' +
      '<div class="field"><label>Jam Mulai</label><input type="number" min="1" value="' + row.jamKeMulai + '" onchange="ubahBarisJadwal(' + idx + ',\'jamKeMulai\',this.value)"></div>' +
      '<div class="field"><label>Jam Selesai</label><input type="number" min="1" value="' + row.jamKeSelesai + '" onchange="ubahBarisJadwal(' + idx + ',\'jamKeSelesai\',this.value)"></div>' +
      '<div class="field"><label>Mata Pelajaran</label><select onchange="ubahBarisJadwal(' + idx + ',\'mapel\',this.value)">' + mapelOptions.replace('value="' + row.mapel + '"', 'value="' + row.mapel + '" selected') + '</select></div>' +
      '<div class="field"><label>Guru</label><select onchange="ubahBarisJadwal(' + idx + ',\'nip\',this.value)">' + guruOptions.replace('value="' + row.nip + '"', 'value="' + row.nip + '" selected') + '</select></div>' +
      '<button class="btn btn-danger btn-sm" style="margin-bottom:14px;" onclick="hapusBarisJadwal(' + idx + ')">✕</button>' +
      '</div>';
  });
  document.getElementById('hariContent').innerHTML = html;
}
function tambahBarisJadwal() {
  const list = jadwalMappingData[jadwalMappingHariAktif];
  const nextJam = list.length > 0 ? Math.max.apply(null, list.map(function (r) { return r.jamKeSelesai; })) + 1 : 1;
  list.push({ jamKeMulai: nextJam, jamKeSelesai: nextJam, mapel: (MASTER.mapel[0] || {}).NamaMapel || '', nip: (MASTER.guru[0] || {}).NIP || '', namaGuru: (MASTER.guru[0] || {}).Nama || '' });
  renderHariContent();
}
function ubahBarisJadwal(idx, field, value) {
  const row = jadwalMappingData[jadwalMappingHariAktif][idx];
  row[field] = (field === 'jamKeMulai' || field === 'jamKeSelesai') ? parseInt(value, 10) : value;
  if (field === 'nip') { const g = MASTER.guru.find(function (x) { return x.NIP === value; }); row.namaGuru = g ? g.Nama : ''; }
}
function hapusBarisJadwal(idx) {
  jadwalMappingData[jadwalMappingHariAktif].splice(idx, 1);
  renderHariContent();
  showToast('Baris jam pelajaran dihapus dari daftar (belum tersimpan).', 'delete');
}
function submitJadwalKelas() {
  const flat = [];
  HARI_LIST.forEach(function (h) { (jadwalMappingData[h] || []).forEach(function (r) { flat.push({ hari: h, jamKeMulai: r.jamKeMulai, jamKeSelesai: r.jamKeSelesai, mapel: r.mapel, nip: r.nip, namaGuru: r.namaGuru }); }); });
  serverCall('saveJadwalKelas', [jadwalMappingKelas, flat], function () {
    showToast('Jadwal kelas ' + jadwalMappingKelas + ' berhasil disimpan.', 'success');
    closeModal('jadwalModal');
    openMappingJadwal();
  });
}
