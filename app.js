/* ══════════════════════════════════════════════════════════════════════
   한컴 KDT 대시보드 – 프론트엔드
   data/courses.json (GitHub Actions가 매일 갱신) 을 로드
   ══════════════════════════════════════════════════════════════════════ */

const DATA_URL = 'data/courses.json';

// ─── 유틸 ────────────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s || s.length < 8) return '-';
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
}
function fmtNum(v, d = 1) {
  return v != null ? Number(v).toFixed(d) : null;
}
function cls(v, good = 80, warn = 60) {
  if (v == null) return 'na';
  return v >= good ? 'good' : v >= warn ? 'warn' : 'bad';
}
function mt(v, unit = '') {
  return v != null ? `${fmtNum(v)}${unit}` : '-';
}

// ─── 과정명 정규화 ───────────────────────────────────────────────────
function normName(name) {
  if (!name) return '기타';
  // K-Digital Training: ... 형태 정리
  const m1 = name.match(/K-Digital Training[:\s]+(.+)/i);
  if (m1) return m1[1].trim().replace(/\s*\d+기\s*$/, '').trim();
  // 기수 번호 제거
  return name.replace(/\s*\d+기\s*$/, '').trim();
}

// ─── 그룹화 ──────────────────────────────────────────────────────────
function groupBy(courses) {
  const map = new Map();
  for (const c of courses) {
    const key = normName(c.courseName);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  for (const [, arr] of map)
    arr.sort((a, b) => (b.cohort || 0) - (a.cohort || 0));
  return new Map(
    [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  );
}

function avg(arr, key) {
  const vals = arr.map((c) => c[key]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// ─── 상태 ────────────────────────────────────────────────────────────
let allCourses = [];
let filtered = [];
const charts = {};

// ─── 필터 적용 ───────────────────────────────────────────────────────
function applyFilters() {
  const org = document.getElementById('filterOrg').value;
  const status = document.getElementById('filterStatus').value;

  filtered = allCourses.filter((c) => {
    if (org && c.orgName !== org) return false;
    if (status && c.status !== status) return false;
    return true;
  });

  render();
}

// ─── 데이터 로드 ─────────────────────────────────────────────────────
async function loadData() {
  const loadEl = document.getElementById('loading');
  const errEl = document.getElementById('error');
  const mainEl = document.getElementById('main');

  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allCourses = data.courses || [];
    filtered = [...allCourses];

    const badge = document.getElementById('badge');
    badge.textContent = `${allCourses.length}개 기수`;
    badge.classList.remove('loading');

    if (data.updatedAt) {
      const d = new Date(data.updatedAt);
      document.getElementById('updated').textContent = `갱신: ${d.toLocaleDateString('ko-KR')} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    }

    // 기관 필터 옵션 채우기
    const orgs = [...new Set(allCourses.map((c) => c.orgName).filter(Boolean))].sort();
    const orgSelect = document.getElementById('filterOrg');
    for (const org of orgs) {
      const opt = document.createElement('option');
      opt.value = org;
      opt.textContent = org;
      orgSelect.appendChild(opt);
    }

    render();
    loadEl.style.display = 'none';
    mainEl.style.display = 'flex';
  } catch (e) {
    loadEl.style.display = 'none';
    errEl.textContent = `데이터를 불러오지 못했습니다: ${e.message}`;
    errEl.style.display = 'block';
  }
}

// ─── 렌더 ────────────────────────────────────────────────────────────
function render() {
  renderKPI();
  renderCourseList();
  renderCharts();
}

// ─── KPI ─────────────────────────────────────────────────────────────
function renderKPI() {
  const groups = groupBy(filtered);
  document.getElementById('kpiCourses').textContent = groups.size;
  document.getElementById('kpiCohorts').textContent = filtered.length;

  const totalTrainees = filtered.reduce(
    (s, c) => s + (c.totalTrainees || 0),
    0
  );
  document.getElementById('kpiTrainees').textContent = totalTrainees
    ? totalTrainees.toLocaleString() + '명'
    : '-';

  const sat = avg(filtered, 'satisfaction');
  document.getElementById('kpiSat').textContent =
    sat != null ? fmtNum(sat) + '점' : '-';

  const emp = avg(filtered, 'employmentRate');
  document.getElementById('kpiEmp').textContent =
    emp != null ? fmtNum(emp) + '%' : '-';
}

// ─── 과정별 드롭다운 리스트 ──────────────────────────────────────────
function renderCourseList() {
  const container = document.getElementById('courseList');
  const groups = groupBy(filtered);
  container.innerHTML = '';

  document.getElementById('listCnt').textContent = `${groups.size}개 과정 · ${filtered.length}개 기수`;

  for (const [name, cohorts] of groups) {
    const avgSat = avg(cohorts, 'satisfaction');
    const avgEmp = avg(cohorts, 'employmentRate');
    const totalTrainees = cohorts.reduce(
      (s, c) => s + (c.totalTrainees || 0),
      0
    );
    const inProg = cohorts.some((c) => c.status === 'in_progress');
    const orgName = cohorts[0]?.orgName || '';

    const group = document.createElement('div');
    group.className = 'cg';

    group.innerHTML = `
      <div class="cg-header">
        <span class="cg-arrow">&#9654;</span>
        <span class="cg-name">${name}${inProg ? ' <span class="status-badge prog">진행중</span>' : ''}
          <span class="cg-org">${orgName}</span>
        </span>
        <div class="cg-tags">
          <span class="cg-tag"><b>${cohorts.length}</b> 기수</span>
          <span class="cg-tag">수강 <b>${totalTrainees.toLocaleString()}</b>명</span>
          <span class="cg-tag">만족도 <b>${avgSat != null ? fmtNum(avgSat) : '-'}</b></span>
          <span class="cg-tag">취업률 <b>${avgEmp != null ? fmtNum(avgEmp) + '%' : '-'}</b></span>
        </div>
      </div>
      <div class="cg-body">
        <div style="overflow-x:auto">
          <table>
            <thead><tr>
              <th>기수</th>
              <th>상태</th>
              <th>훈련기간</th>
              <th>수강</th>
              <th>수료</th>
              <th>수료율</th>
              <th>만족도</th>
              <th>취업률</th>
              <th>평균임금</th>
              <th>상세</th>
            </tr></thead>
            <tbody>
              ${cohorts
                .map((c) => {
                  const period =
                    c.startDate && c.endDate
                      ? `${fmtDate(c.startDate)} ~ ${fmtDate(c.endDate)}`
                      : '-';
                  const stBadge =
                    c.status === 'in_progress'
                      ? '<span class="status-badge prog">진행중</span>'
                      : c.status === 'pending_stats'
                      ? '<span class="status-badge wait">집계대기</span>'
                      : c.status === 'no_stats'
                      ? '<span class="status-badge nostats">통계없음</span>'
                      : '<span style="color:var(--text3);font-size:11px">완료</span>';
                  return `<tr class="${c.status === 'in_progress' ? 'row-prog' : ''}">
                  <td><span class="cohort-badge">${c.cohort || '-'}기</span></td>
                  <td>${stBadge}</td>
                  <td>${period}</td>
                  <td>${c.totalTrainees != null ? c.totalTrainees + '명' : '<span class="metric na">-</span>'}</td>
                  <td>${c.completedTrainees != null ? c.completedTrainees + '명' : '<span class="metric na">-</span>'}</td>
                  <td class="metric ${cls(c.completionRate, 80, 60)}">${mt(c.completionRate, '%')}</td>
                  <td class="metric ${cls(c.satisfaction, 85, 70)}">${mt(c.satisfaction, '점')}</td>
                  <td class="metric ${cls(c.employmentRate, 70, 50)}">${mt(c.employmentRate, '%')}</td>
                  <td>${c.avgWage != null ? Math.round(c.avgWage).toLocaleString() + '만원' : '<span class="metric na">-</span>'}</td>
                  <td>${c.detailUrl ? `<a href="${c.detailUrl}" target="_blank" rel="noopener" style="color:var(--primary);font-size:12px">보기 &nearr;</a>` : '-'}</td>
                </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    group
      .querySelector('.cg-header')
      .addEventListener('click', () => group.classList.toggle('open'));
    container.appendChild(group);
  }
}

// ─── 차트 ────────────────────────────────────────────────────────────
const PAL = [
  '#0066cc', '#ff6600', '#38a169', '#e53e3e', '#8b5cf6',
  '#06b6d4', '#ec4899', '#d69e2e', '#f97316', '#6366f1',
];

function renderCharts() {
  lineChart('cSat', 'satisfaction', '만족도 (점)', 100);
  lineChart('cEmp', 'employmentRate', '취업률 (%)', 100);
  lineChart('cComp', 'completionRate', '수료율 (%)', 100);
  barChart('cTrainees', 'totalTrainees', '수강인원 (명)');
}

function lineChart(id, key, label, max) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const ctx = document.getElementById(id)?.getContext('2d');
  if (!ctx) return;

  const groups = groupBy(filtered);
  const datasets = [];
  let ci = 0;

  for (const [name, items] of groups) {
    const sorted = [...items].sort((a, b) => (a.cohort || 0) - (b.cohort || 0));
    if (!sorted.some((c) => c[key] != null)) continue;
    const color = PAL[ci++ % PAL.length];
    datasets.push({
      label: name.length > 18 ? name.slice(0, 16) + '…' : name,
      data: sorted.map((c) => ({
        x: c.cohort,
        y: c[key] != null ? +Number(c[key]).toFixed(1) : null,
      })),
      borderColor: color,
      backgroundColor: color + '20',
      fill: false,
      tension: 0.3,
      pointRadius: 4,
      pointHoverRadius: 6,
      spanGaps: false,
    });
  }

  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: '기수', font: { size: 11 } },
          ticks: { stepSize: 1, precision: 0 },
        },
        y: {
          min: 0,
          max,
          title: { display: true, text: label, font: { size: 11 } },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            title: (items) =>
              `${items[0].dataset.label} — ${items[0].parsed.x}기`,
            label: (item) => `${label}: ${item.parsed.y ?? '-'}`,
          },
        },
      },
    },
  });
}

function barChart(id, key, label) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const ctx = document.getElementById(id)?.getContext('2d');
  if (!ctx) return;

  const groups = groupBy(filtered);
  const datasets = [];
  let ci = 0;

  for (const [name, items] of groups) {
    const sorted = [...items].sort((a, b) => (a.cohort || 0) - (b.cohort || 0));
    if (!sorted.some((c) => c[key] != null)) continue;
    const color = PAL[ci++ % PAL.length];
    datasets.push({
      label: name.length > 18 ? name.slice(0, 16) + '…' : name,
      data: sorted.map((c) => ({
        x: c.cohort,
        y: c[key] ?? null,
      })),
      backgroundColor: color + '80',
      borderColor: color,
      borderWidth: 1,
    });
  }

  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: '기수', font: { size: 11 } },
          ticks: { stepSize: 1, precision: 0 },
        },
        y: {
          min: 0,
          title: { display: true, text: label, font: { size: 11 } },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 11 }, boxWidth: 12 },
        },
      },
    },
  });
}

// ─── CSV 내보내기 ────────────────────────────────────────────────────
function exportCsv() {
  const headers = [
    '과정명', '기수', '상태', '훈련기관', '시작일', '종료일',
    '수강인원', '수료인원', '수료율', '만족도', '취업률', '평균임금(만원)',
  ];
  const rows = filtered.map((c) => [
    c.courseName || '',
    c.cohort || '',
    c.status === 'in_progress' ? '진행중' : c.status === 'pending_stats' ? '집계대기' : c.status === 'no_stats' ? '통계없음' : '완료',
    c.orgName || '',
    fmtDate(c.startDate),
    fmtDate(c.endDate),
    c.totalTrainees ?? '',
    c.completedTrainees ?? '',
    fmtNum(c.completionRate) ?? '',
    fmtNum(c.satisfaction) ?? '',
    fmtNum(c.employmentRate) ?? '',
    c.avgWage != null ? Math.round(c.avgWage) : '',
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob(['\uFEFF' + csv], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hancom_kdt_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 이벤트 ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  document.getElementById('csvBtn').addEventListener('click', exportCsv);
  document.getElementById('filterOrg').addEventListener('change', applyFilters);
  document.getElementById('filterStatus').addEventListener('change', applyFilters);
});
