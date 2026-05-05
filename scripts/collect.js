/**
 * 한컴 KDT 과정 실적 수집 스크립트
 *
 * 1) 고용24 Open API → 한컴 관련 훈련과정 목록 + 기본 지표
 * 2) 고용24 웹 → 수료/취업 통계 보강
 * 3) 고용24 웹 → 기수별 만족도 상세
 * 4) data/courses.json 으로 저장 (GitHub Actions가 커밋)
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.work24.go.kr';
const API_URL = `${BASE_URL}/cm/openApi/call/hr/callOpenApiSvcInfo310L01.do`;

// 한컴 관련 훈련기관 검색어 목록
const SEARCH_ORGS = ['한컴'];

const DELAY = 400;

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

// ─── 유틸 ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const toYmd = (s) =>
  s ? String(s).replace(/[^0-9]/g, '').slice(0, 8) || null : null;
const pf = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
};
const pi = (s) => {
  if (s == null || s === '') return null;
  const n = parseInt(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
};

// ─── ① Open API: 과정 목록 (C0104 = KDT) ────────────────────────────
async function fetchFromOpenApi(apiKey, orgName) {
  const courses = [];
  let pageNum = 1;
  let totalPages = 1;

  while (pageNum <= totalPages) {
    const params = new URLSearchParams({
      authKey: apiKey,
      returnType: 'JSON',
      outType: '1',
      pageNum: String(pageNum),
      pageSize: '100',
      srchTraStDt: '20200101',
      srchTraEndDt: '20271231',
      sort: 'ASC',
      sortCol: '1',
      crseTracseSe: 'C0104',
      srchTraOrganNm: orgName,
    });

    const res = await fetch(`${API_URL}?${params}`);
    const data = await res.json();

    if (data.error) throw new Error(`API 오류: ${data.error}`);

    const items = data.srchList || [];
    const total = parseInt(data.scn_cnt) || 0;
    totalPages = Math.ceil(total / 100);

    for (const item of items) {
      courses.push({
        trprId: item.trprId,
        cohort: pi(item.trprDegr),
        courseName: item.title || '',
        startDate: toYmd(item.traStartDate),
        endDate: toYmd(item.traEndDate),
        totalTrainees: pi(item.regCourseMan),
        capacity: pi(item.yardMan),
        satisfaction: pf(item.stdgScor),
        employmentRate3m: pf(item.eiEmplRate3),
        employmentRate6m: pf(item.eiEmplRate6),
        grade: item.grade || null,
        orgName: item.subTitle || orgName,
        orgId: item.trainstCstId || null,
        detailUrl: item.titleLink || null,
      });
    }

    console.log(
      `[api] "${orgName}" page ${pageNum}/${totalPages}, ${items.length}건 (전체 ${total})`
    );
    pageNum++;
    if (pageNum <= totalPages) await sleep(DELAY);
  }

  return courses;
}

// ─── ② 만족도 AJAX (기수별 상세) ─────────────────────────────────────
async function fetchSatisfaction(tracseId, cohort) {
  try {
    const res = await fetch(
      `${BASE_URL}/hr/a/a/3100/selectSatisfactionAjax.do?tracseId=${tracseId}&srchTracseTme=${cohort}`,
      {
        headers: {
          ...UA,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
          Referer: `${BASE_URL}/hr/a/a/3100/selectTracseDetl.do?tracseId=${tracseId}`,
        },
      }
    );
    const data = await res.json();

    let score = null;
    const list = data?.satisfactiontlcTrneList;
    if (Array.isArray(list)) {
      const overall = list.find((i) => i.inqRelmIemCd === '01');
      if (overall) score = pf(overall.stsfdgPerScore);
    }
    if (score == null) {
      const info =
        data?.satisfactiontlcTrneInfo || data?.setisfactionMap;
      if (info) {
        const per = pf(info.perEvlScore);
        if (per && per > 0) score = per;
      }
    }

    const info = data?.satisfactiontlcTrneInfo;
    return {
      score,
      surveyTrainees: info ? pi(info.totTrneeCo) : null,
      evalCount: info ? pi(info.evalCnt) : null,
    };
  } catch {
    return null;
  }
}

// ─── ③ 수료/취업 통계 (웹 크롤링) ────────────────────────────────────
async function fetchCompletionStats(orgId) {
  const stats = new Map();
  if (!orgId) return stats;

  for (const year of [2026, 2025, 2024, 2023, 2022, 2021, 2020]) {
    let pg = 1,
      maxPg = 1;
    while (pg <= maxPg) {
      try {
        const res = await fetch(
          `${BASE_URL}/hr/a/a/3100/selectInsttRtList.do`,
          {
            method: 'POST',
            body: `stdrYear=${year}&trainstCstmrId=${orgId}&pageIndex=${pg}`,
            headers: {
              ...UA,
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
            },
          }
        );
        const html = await res.text();
        const totM = html.match(/totalNum[\s\S]*?<strong[^>]*>(\d+)/);
        const total = totM ? parseInt(totM[1]) : 0;
        if (total === 0) break;
        maxPg = Math.ceil(total / 10);

        const trRe = /<tr>([\s\S]*?)<\/tr>/gi;
        let trm;
        while ((trm = trRe.exec(html)) !== null) {
          const tds = [];
          const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
          let tdm;
          while ((tdm = tdRe.exec(trm[1])) !== null)
            tds.push(strip(tdm[1]));
          if (tds.length < 6) continue;
          const dateM = tds[0].match(/\((\d{8})-(\d{8})\)/);
          if (!dateM) continue;
          const cohM = tds[0].match(/\[(\d+)회차/);
          const key = `${cohM ? cohM[1] : '?'}-${dateM[1]}-${dateM[2]}`;
          stats.set(key, {
            completed: pi(tds[2]),
            employed: pi(tds[3]),
            empRate: pf(tds[4]),
            avgWage: pi(tds[5].replace(/,/g, '')),
          });
        }
        pg++;
        await sleep(DELAY);
      } catch {
        break;
      }
    }
  }
  return stats;
}

// ─── ④ 전체 수집 파이프라인 ──────────────────────────────────────────
async function collectAll(apiKey) {
  // 1) Open API로 과정 목록 수집
  console.log('[collect] Open API 호출 시작');
  let allRaw = [];
  for (const org of SEARCH_ORGS) {
    const courses = await fetchFromOpenApi(apiKey, org);
    allRaw = allRaw.concat(courses);
  }

  // 중복 제거 (trprId + cohort 기준)
  const seen = new Set();
  const apiCourses = allRaw.filter((c) => {
    const key = `${c.trprId}-${c.cohort}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `[collect] API 총 ${allRaw.length}건 → 중복 제거 후 ${apiCourses.length}건`
  );
  if (!apiCourses.length) {
    console.log('[collect] 수집된 과정이 없습니다.');
    return [];
  }

  // 2) 기관별 수료통계 크롤링
  const orgIds = [...new Set(apiCourses.map((c) => c.orgId).filter(Boolean))];
  console.log(`[collect] 수료통계 크롤링 대상 기관: ${orgIds.length}개`);

  const allStats = new Map();
  for (const orgId of orgIds) {
    const stats = await fetchCompletionStats(orgId).catch(() => new Map());
    for (const [k, v] of stats) allStats.set(k, v);
  }
  console.log(`[collect] 수료통계 총 ${allStats.size}건`);

  // 3) 기수별 만족도 상세 수집 (종료된 과정만)
  const now = new Date().toISOString().replace(/[-T:Z]/g, '').slice(0, 8);
  const finishedCourses = apiCourses.filter(
    (c) => c.endDate && c.endDate <= now
  );
  console.log(
    `[collect] 만족도 상세 조회 대상: ${finishedCourses.length}건 (종료된 과정)`
  );

  const satMap = new Map();
  for (const c of finishedCourses) {
    const key = `${c.trprId}-${c.cohort}`;
    await sleep(DELAY);
    const sat = await fetchSatisfaction(c.trprId, c.cohort);
    if (sat) satMap.set(key, sat);
  }
  console.log(`[collect] 만족도 상세 ${satMap.size}건 수집`);

  // 4) 데이터 병합
  const results = apiCourses.map((c) => {
    const satKey = `${c.trprId}-${c.cohort}`;
    const sat = satMap.get(satKey);
    const statsKey = `${c.cohort}-${c.startDate}-${c.endDate}`;
    const st = allStats.get(statsKey);

    const satisfaction = sat?.score ?? c.satisfaction;
    const completedTrainees = st?.completed ?? null;
    const employmentRate = st?.empRate ?? c.employmentRate3m;
    const avgWage = st?.avgWage ?? null;

    let completionRate = null;
    if (c.totalTrainees && completedTrainees) {
      completionRate =
        Math.round((completedTrainees / c.totalTrainees) * 1000) / 10;
    }

    let status = 'completed';
    if (c.endDate && c.endDate > now) {
      status = 'in_progress';
    } else if (!completedTrainees && c.endDate && c.endDate <= now) {
      const endMs = new Date(
        c.endDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
      ).getTime();
      const sixMonths = 180 * 24 * 60 * 60 * 1000;
      status = Date.now() - endMs > sixMonths ? 'no_stats' : 'pending_stats';
    }

    return {
      id: `${c.trprId}-${c.cohort}`,
      tracseId: c.trprId,
      courseName: c.courseName,
      cohort: c.cohort,
      startDate: c.startDate,
      endDate: c.endDate,
      totalTrainees: c.totalTrainees,
      capacity: c.capacity,
      completedTrainees,
      completionRate,
      satisfaction,
      employmentRate,
      avgWage,
      grade: c.grade,
      orgName: c.orgName,
      status,
      detailUrl: c.detailUrl,
    };
  });

  const matched = results.filter((r) => r.completedTrainees != null).length;
  console.log(`[collect] 수료통계 매칭: ${matched}/${results.length}건`);

  return results.sort((a, b) => {
    const nc = (a.courseName || '').localeCompare(b.courseName || '', 'ko');
    return nc !== 0 ? nc : (a.cohort || 0) - (b.cohort || 0);
  });
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.WORK24_API_KEY;
  if (!apiKey) {
    console.error('WORK24_API_KEY 환경변수가 설정되지 않았습니다.');
    process.exit(1);
  }

  try {
    const courses = await collectAll(apiKey);

    const payload = {
      source: 'openapi',
      courses,
      updatedAt: new Date().toISOString(),
      count: courses.length,
    };

    const outPath = path.join(__dirname, '..', 'data', 'courses.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`\n[done] ${courses.length}건 → ${outPath}`);
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
}

main();
