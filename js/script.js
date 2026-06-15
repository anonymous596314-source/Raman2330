// Chart instances (to destroy before re-rendering)
const charts = {};

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    setupSidebar();
    setupRefreshLogic();
    runApiDiagnostics(); // 背景執行，不阻塞頁面載入，F12 Console 可看結果
    await refreshData();
}

function setupSidebar() {
    const navItems = document.querySelectorAll('.nav-item');
    const panels = document.querySelectorAll('.panel');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(nav => nav.classList.remove('active'));
            panels.forEach(panel => panel.classList.remove('active'));
            item.classList.add('active');
            const targetPanel = document.getElementById(`panel-${item.dataset.panel}`);
            if (targetPanel) targetPanel.classList.add('active');
        });
    });
}

function setupRefreshLogic() {
    const refreshBtn = document.getElementById('refresh-btn');
    refreshBtn.addEventListener('click', async () => {
        refreshBtn.classList.add('loading');
        await refreshData();
        refreshBtn.classList.remove('loading');
    });
    setInterval(async () => { await refreshData(true); }, 60000);
}

async function refreshData(partial = false) {
    updateTimestamp();

    // ── 第一波：Quote + News 並行（畫面最快有資料）──────────────
    const [quote, news] = await Promise.allSettled([
        fetchQuoteSummary(),
        fetchNews()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    if (quote) {
        document.getElementById('current-price').innerText = quote.price.toFixed(2);
        const changeEl = document.getElementById('price-change');
        const sign = quote.change >= 0 ? '+' : '';
        changeEl.innerText = `${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
        changeEl.className = 'price-change ' + (quote.change >= 0 ? 'up' : 'down');
        // 更新分析師目標價（對比現價）
        renderAnalystTargets(quote.price);
        updateCalc();
    } else {
        renderAnalystTargets(null);
    }

    if (news && news.length > 0) {
        const newsContainer = document.getElementById('news-container');
        newsContainer.innerHTML = '<h4>即時外資報告與新聞</h4>' + news.map(n => `
            <div class="news-item">
                <a href="${n.link}" target="_blank" rel="noopener noreferrer"><h5>${escapeHtml(n.title)}</h5></a>
                <p>${escapeHtml(n.publisher)} - ${new Date(n.providerPublishTime * 1000).toLocaleString('zh-TW')}</p>
            </div>
        `).join('');
        analyzeSentiment(news);
    } else {
        const newsContainer = document.getElementById('news-container');
        if (newsContainer) {
            newsContainer.innerHTML = '<h4>即時外資報告與新聞</h4><div class="chart-fallback" style="margin-top:12px;"><strong>新聞資料暫時無法取得</strong><span>Yahoo Finance proxy 未回應，請按右上角「更新資料」重試。情緒分析將在新聞載入後自動更新。</span></div>';
        }
    }

    if (partial) return;

    // ── 第二波：分兩批避免 Twelve Data rate limit（8次/分鐘）──
    // 第一批：FinMind（不受限）+ 台積電歷史（2支 Twelve Data）
    const [fund, techData, chipData, flowData, tsm1yData] =
        await Promise.allSettled([
            fetchFundamentals(),                          // FinMind，不受 TD 限制
            fetchHistoricalData("6mo", "1d"),             // TD: 技術面日線
            fetchHistoricalData("10y", "1wk"),            // TD: 籌碼成本週線
            fetchChipFlow(),                              // FinMind，不受 TD 限制
            fetchHistoricalData("1y",  "1wk"),            // TD: 台積1年週線
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // 等 1.5 秒再打第二批，避免觸發 rate limit
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 第二批：TSM ADR、SOXX、匯率、VIX、SPY（5支）
    const [twdData, soxData, adrData, vixData, spyData] =
        await Promise.allSettled([
            fetchHistoricalData("1y",  "1wk", "TWD=X"),  // TD: 匯率
            fetchHistoricalData("1y",  "1wk", SOX_SYMBOL), // TD: SOXX
            fetchHistoricalData("1y",  "1wk", ADR_SYMBOL), // TD: TSM ADR
            fetchVIX(),                                       // TD: VIX
            fetchHistoricalData("1y",  "1wk", "SPY")     // TD: S&P500
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // 等 1.5 秒再打第三批，避免觸發 rate limit
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 第三批：PER、外資持股、股息歷史、融資融券（全部 FinMind）
    const [perHistory, shareholdingHistory, dividendHistory, marginData] =
        await Promise.allSettled([
            fetchPERHistory(3),
            fetchShareholdingHistory(24),
            fetchDividendHistory(),
            fetchMarginData(12)
        ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // 3. 基本面
    if (fund) {
        document.getElementById('pe-ratio').innerText = fund.peRatio ? (typeof fund.peRatio === 'number' ? fund.peRatio.toFixed(2) : fund.peRatio) : '--';
        document.getElementById('eps-ttm').innerText = fund.eps ? fund.eps.toFixed(2) : '--';
        const roeEl = document.getElementById('roe-value');
        if (roeEl) roeEl.innerText = fund.roe || '--';
        const divEl = document.getElementById('dividend-yield');
        if (divEl) divEl.innerText = fund.dividendYield || '--';
        if (fund.foreignRatio && fund.foreignRatio !== '--') {
            document.getElementById('foreign-ratio').innerText = fund.foreignRatio + '%';
        }
        renderFundamentalChart();
        renderEpsChart();
        renderYoyChart();
        renderMarginStackChart();
        renderCashflowCapexChart();
    }

    // 4. 技術面
    if (techData && techData.length > 0) {
        renderTechnicalChart(techData);
        renderVolumeChart(techData);
        renderRsiChart(techData);
        renderMacdChart(techData);
    } else {
        ['technical-chart', 'kd-chart', 'volume-chart', 'rsi-chart', 'macd-chart'].forEach(showChartFallback);
    }

    // 5. 籌碼面
    if (chipData && chipData.length > 0) {
        renderChipCostChart(chipData);
    } else {
        showChartFallback('chip-cost-chart');
    }
    if (flowData) {
        renderChipFlowChart(flowData);
        renderChipCumulativeChart(flowData);
        const sumForeign = flowData.foreign.reduce((a, b) => a + b, 0);
        const sumTrust = flowData.trust.reduce((a, b) => a + b, 0);
        const sumDealer = flowData.dealer.reduce((a, b) => a + b, 0);
        const fmt = (v) => {
            const el_sign = v >= 0 ? '+' : '';
            return `${el_sign}${Math.round(v).toLocaleString()}`;
        };
        const fEl = document.getElementById('foreign-net-30d');
        const tEl = document.getElementById('trust-net-30d');
        const dEl = document.getElementById('dealer-net-30d');
        if (fEl) { fEl.innerText = fmt(sumForeign); fEl.style.color = sumForeign >= 0 ? '#ef4444' : '#22c55e'; }
        if (tEl) { tEl.innerText = fmt(sumTrust); tEl.style.color = sumTrust >= 0 ? '#ef4444' : '#22c55e'; }
        if (dEl) { dEl.innerText = fmt(sumDealer); dEl.style.color = sumDealer >= 0 ? '#ef4444' : '#22c55e'; }
    } else {
        renderChipFlowChart();
        renderChipCumulativeChart();
    }

    // 6. 總經面
    if (twdData && twdData.length > 0 && tsm1yData && tsm1yData.length > 0) {
        renderMacroChart(tsm1yData, twdData);
    } else {
        showChartFallback('macro-chart');
    }
    if (soxData && soxData.length > 0 && adrData && adrData.length > 0) {
        renderSoxAdrChart(tsm1yData, soxData, adrData);
    } else {
        showChartFallback('sox-adr-chart');
    }
    updateMacroSnapshot(tsm1yData || [], twdData || [], soxData || [], adrData || []);

    // 7. 新動態圖表
    if (perHistory && perHistory.length > 0) {
        renderPERBandChart(perHistory);
    } else {
        showChartFallback('per-band-chart');
    }

    if (shareholdingHistory && shareholdingHistory.length > 0) {
        renderShareholdingChart(shareholdingHistory);
    } else {
        showChartFallback('shareholding-chart');
    }

    if (vixData && vixData.length > 0 && tsm1yData && tsm1yData.length > 0) {
        renderVIXChart(tsm1yData, vixData);
    } else {
        showChartFallback('vix-chart');
    }

    // 相關性熱力圖（需要 tsm1yData, soxData, adrData, spyData）
    try {
        renderCorrelationHeatmap(tsm1yData, soxData, adrData, spyData);
    } catch(e) {
        console.error('[renderCorrelationHeatmap]', e);
        showChartFallback('correlation-heatmap');
    }

    if (dividendHistory && dividendHistory.length > 0) {
        try { renderDividendChart(dividendHistory); } catch(e) { console.error('[renderDividendChart]',e); showChartFallback('dividend-chart'); }
    } else {
        showChartFallback('dividend-chart');
    }

    if (marginData && marginData.length > 0) {
        try { renderMarginChart(marginData); } catch(e) { console.error('[renderMarginChart ERROR]', e.message, e.stack); showChartFallback('margin-chart'); }
    } else {
        showChartFallback('margin-chart');
    }

    // 靜態圖（不需 API）- 每個包 try-catch 互不影響
    try { renderCustomerConcentration(); }   catch(e) { console.error('[renderCustomerConcentration]', e); }
    try { renderProcessRoadmapChart(); }      catch(e) { console.error('[renderProcessRoadmapChart]', e); }
    try { renderScenarioChart(); }        catch(e) { console.error('[renderScenarioChart]', e); }

    // 8. 靜態圖表
    try { renderIndustryChart(); }        catch(e) { console.error('[renderIndustryChart]', e); }
    try { renderOutlookChart(); }         catch(e) { console.error('[renderOutlookChart]', e); }
    try { renderRiskChart(); }            catch(e) { console.error('[renderRiskChart]', e); }
    try { renderValuationCalculator(); }  catch(e) { console.error('[renderValuationCalculator]', e); }
}

function updateTimestamp() {
    document.getElementById('last-update-time').innerText = new Date().toLocaleString('zh-TW');
}

// ─── Chart Defaults ────────────────────────────────────────────
if (typeof window.Chart !== 'undefined') {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = 'Inter';
}

function createChart(ctxId, config) {
    const ctx = document.getElementById(ctxId);
    if (!ctx) return;
    if (typeof window.Chart === 'undefined') {
        const fallback = document.createElement('div');
        fallback.className = 'chart-fallback';
        fallback.innerHTML = '<strong>圖表套件未載入</strong><span>請確認網路可連到 Chart.js CDN 後重新整理。</span>';
        ctx.replaceWith(fallback);
        return;
    }
    if (charts[ctxId]) charts[ctxId].destroy();
    charts[ctxId] = new Chart(ctx, config);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value ?? '';
    return div.innerHTML;
}

/**
 * 當 API 資料抓不到時，在 canvas 位置顯示友善提示
 */
function showChartFallback(ctxId, msg) {
    const el = document.getElementById(ctxId);
    if (!el) return;
    // 若已被替換成 div，不重複替換
    if (el.tagName !== 'CANVAS') return;
    const fb = document.createElement('div');
    fb.className = 'chart-fallback';
    fb.innerHTML = `<strong>資料暫時無法取得</strong><span>${msg || 'Yahoo Finance / FinMind proxy 未回應，請按右上角「更新資料」重試，或稍後再試。'}</span>`;
    el.replaceWith(fb);
}

// ─── 基本面圖表 ────────────────────────────────────────────────
const QUARTER_LABELS = ['24Q1','24Q2','24Q3','24Q4','25Q1','25Q2','25Q3','25Q4','26Q1'];
const REVENUES_B     = [592.64, 673.51, 759.69, 868.46, 839.25, 933.79, 989.92, 1046.09, 1134.10];
const GROSS_MARGINS  = [53.1, 53.2, 57.8, 59.0, 58.8, 58.6, 59.5, 62.3, 66.3];
const EPS_QUARTERLY  = [7.98, 9.56, 12.55, 14.45, 13.95, 15.36, 17.44, 19.51, 22.08];
const OPERATING_MARGINS = [42.0, 42.5, 47.5, 49.0, 48.5, 49.6, 50.6, 54.0, 58.1];
const NET_MARGINS = [38.0, 36.8, 42.8, 43.1, 43.1, 44.3, 45.7, 48.4, 50.5];
const ANNUAL_LABELS = ['2021', '2022', '2023', '2024', '2025'];
const ANNUAL_REVENUE_B = [1587, 2264, 2161, 2894, 3809];
const ANNUAL_CAPEX_USD_B = [30.0, 36.3, 30.4, 30.0, 29.8];
const ANNUAL_DIVIDEND = [11.0, 11.0, 12.0, 14.0, 18.0];

function renderFundamentalChart() {
    createChart('fundamental-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '營收 (十億台幣)',
                data: REVENUES_B,
                backgroundColor: 'rgba(59, 130, 246, 0.75)',
                yAxisID: 'y'
            }, {
                label: '毛利率 (%)',
                data: GROSS_MARGINS,
                type: 'line',
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239,68,68,0.1)',
                fill: true,
                borderWidth: 3,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#ef4444',
                yAxisID: 'y1'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y:  { type: 'linear', position: 'left',  grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, min: 45, max: 72, title: { display: true, text: '毛利率 %' } }
            }
        }
    });
}

function renderEpsChart() {
    createChart('eps-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '單季 EPS (NT$)',
                data: EPS_QUARTERLY,
                backgroundColor: EPS_QUARTERLY.map((v, i) => i > 0 && v > EPS_QUARTERLY[i-1] ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)'),
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'NT$ / 股' } } }
        }
    });
}

function renderYoyChart() {
    // 同期對比：24Q1 vs 23Q1 等（使用近似值）
    const prevYearRevs = [508, 480, 546, 625, 592.64, 673.51, 759.69, 868.46, 839.25];
    const yoy = REVENUES_B.map((r, i) => prevYearRevs[i] ? ((r - prevYearRevs[i]) / prevYearRevs[i] * 100) : null);

    createChart('yoy-chart', {
        type: 'bar',
        data: {
            labels: QUARTER_LABELS,
            datasets: [{
                label: '營收年增率 YoY (%)',
                data: yoy,
                backgroundColor: yoy.map(v => v >= 0 ? 'rgba(59,130,246,0.8)' : 'rgba(239,68,68,0.8)'),
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: 'YoY %' } } }
        }
    });
}

function renderMarginStackChart() {
    createChart('margin-stack-chart', {
        type: 'line',
        data: {
            labels: QUARTER_LABELS,
            datasets: [
                { label: '毛利率', data: GROSS_MARGINS, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 },
                { label: '營業利益率', data: OPERATING_MARGINS, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 },
                { label: '淨利率', data: NET_MARGINS, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', borderWidth: 2.5, tension: 0.35, pointRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, min: 30, max: 70, title: { display: true, text: 'Margin %' } }
            }
        }
    });
}

function renderCashflowCapexChart() {
    createChart('cashflow-capex-chart', {
        type: 'bar',
        data: {
            labels: ANNUAL_LABELS,
            datasets: [
                {
                    label: '營收 (十億台幣)',
                    data: ANNUAL_REVENUE_B,
                    backgroundColor: 'rgba(59,130,246,0.74)',
                    borderRadius: 4,
                    yAxisID: 'y'
                },
                {
                    label: '資本支出 (十億美元)',
                    data: ANNUAL_CAPEX_USD_B,
                    type: 'line',
                    borderColor: '#f59e0b',
                    borderWidth: 3,
                    tension: 0.25,
                    pointRadius: 4,
                    yAxisID: 'y1'
                },
                {
                    label: '每股現金股利 (NT$)',
                    data: ANNUAL_DIVIDEND,
                    type: 'line',
                    borderColor: '#10b981',
                    borderDash: [5, 4],
                    borderWidth: 2,
                    tension: 0.25,
                    pointRadius: 4,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'USD B / NT$' } }
            }
        }
    });
}

// ─── 技術面圖表 ────────────────────────────────────────────────
function renderTechnicalChart(data) {
    if (!data?.length) { showChartFallback('technical-chart'); return; }

    const labels = data.map(d => {
        const dt = new Date(d.date);
        return `${dt.getMonth()+1}/${dt.getDate()}`;
    });
    const closes = data.map(d => d.close);

    // 布林通道 + 中長期均線
    const bb    = calculateBollingerBands(data, 20, 2);
    const ma60  = calculateMA(data, 60);
    const ma120 = calculateMA(data, 120);
    const ma240 = calculateMA(data, 240);

    createChart('technical-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '收盤價',          data: closes,   borderColor: '#f8fafc',               borderWidth: 2,   pointRadius: 0, tension: 0.1 },
                { label: '布林上軌',         data: bb.upper, borderColor: 'rgba(239,68,68,0.7)',   borderWidth: 1,   borderDash: [4,3], pointRadius: 0, fill: false },
                { label: '布林中線 (MA20)',  data: bb.ma,    borderColor: 'rgba(148,163,184,0.8)', borderWidth: 1.5, pointRadius: 0 },
                { label: '布林下軌',         data: bb.lower, borderColor: 'rgba(34,197,94,0.7)',   borderWidth: 1,   borderDash: [4,3], pointRadius: 0, fill: '+1', backgroundColor: 'rgba(34,197,94,0.04)' },
                { label: 'MA60',             data: ma60,     borderColor: '#f59e0b',               borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'MA120',            data: ma120,    borderColor: '#a78bfa',               borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
                { label: 'MA240',            data: ma240,    borderColor: '#fb923c',               borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', boxWidth: 16, font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: NT$${ctx.raw?.toFixed ? ctx.raw.toFixed(0) : '--'}` } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: '#94a3b8', callback: v => 'NT$' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });

    // KD 指標（超買超賣 + 交叉訊號）
    const kd = calculateKD(data);
    const kdDatasets = [
        { label: 'K 值', data: kd.k, borderColor: '#3b82f6', borderWidth: 2, tension: 0.3, pointRadius: 0 },
        { label: 'D 值', data: kd.d, borderColor: '#f59e0b', borderWidth: 2, tension: 0.3, pointRadius: 0 }
    ];

    // 標記黃金交叉和死亡交叉
    const crossPoints = kd.k.map((k, i) => {
        if (i === 0 || k === null || kd.k[i-1] === null) return null;
        if (kd.k[i-1] < kd.d[i-1] && k > kd.d[i]) return { x: labels[i], y: k, type: 'golden' };
        if (kd.k[i-1] > kd.d[i-1] && k < kd.d[i]) return { x: labels[i], y: k, type: 'death' };
        return null;
    }).filter(Boolean);

    createChart('kd-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                ...kdDatasets,
                // 超買區背景（K>80）和超賣區背景（K<20）用點表示
                {
                    label: '超買 (K>80)',
                    data: kd.k.map(v => v !== null && v > 80 ? v : null),
                    borderColor: 'rgba(239,68,68,0.9)', backgroundColor: 'rgba(239,68,68,0.15)',
                    borderWidth: 0, pointRadius: 3, pointStyle: 'circle', showLine: false
                },
                {
                    label: '超賣 (K<20)',
                    data: kd.k.map(v => v !== null && v < 20 ? v : null),
                    borderColor: 'rgba(34,197,94,0.9)', backgroundColor: 'rgba(34,197,94,0.15)',
                    borderWidth: 0, pointRadius: 3, pointStyle: 'circle', showLine: false
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', filter: item => item.datasetIndex < 2 } },
                tooltip: { callbacks: { label: ctx => ctx.datasetIndex < 2 ? ` ${ctx.dataset.label}: ${ctx.raw?.toFixed(1) ?? '--'}` : null } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    min: 0, max: 100,
                    ticks: { color: '#94a3b8', callback: v => v },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                }
            }
        }
    });
}

function renderVolumeChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const volumes = data.map(d => Math.round((d.volume || 0) / 1000)); // 千股
    const colors = data.map((d, i) => i === 0 ? 'rgba(59,130,246,0.7)' : (d.close >= data[i-1].close ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)'));

    createChart('volume-chart', {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: '成交量 (千股)', data: volumes, backgroundColor: colors, borderRadius: 2 }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '千股' } }
            }
        }
    });
}

function renderRsiChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const rsi = calculateRSI(data, 14);

    createChart('rsi-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'RSI 14', data: rsi, borderColor: '#8b5cf6', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '偏熱 70', data: labels.map(() => 70), borderColor: 'rgba(239,68,68,0.7)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 },
                { label: '偏冷 30', data: labels.map(() => 30), borderColor: 'rgba(34,197,94,0.7)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

function renderMacdChart(data) {
    const labels = data.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);
    const macd = calculateMACD(data);

    createChart('macd-chart', {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Histogram',
                    data: macd.histogram,
                    backgroundColor: macd.histogram.map(v => v >= 0 ? 'rgba(239,68,68,0.72)' : 'rgba(34,197,94,0.72)'),
                    borderRadius: 2
                },
                { label: 'DIF', data: macd.dif, type: 'line', borderColor: '#3b82f6', borderWidth: 2, tension: 0.25, pointRadius: 0 },
                { label: 'DEA', data: macd.dea, type: 'line', borderColor: '#f59e0b', borderWidth: 2, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

// ─── 籌碼面圖表 ────────────────────────────────────────────────
function renderChipCostChart(data) {
    const canvasEl = document.getElementById('chip-cost-chart');
    if (!canvasEl) return;

    if (!data || data.length < 53) {
        const fb = document.createElement('div');
        fb.className = 'chart-fallback';
        fb.innerHTML = '<strong>法人成本資料暫時無法取得</strong><span>Yahoo Finance CORS proxy 未回應，請稍後按右上角「更新資料」重試。</span>';
        canvasEl.replaceWith(fb);
        return;
    }

    const labels = data.map(d => `${d.date.getFullYear()}/${d.date.getMonth()+1}`);
    const closes = data.map(d => d.close);
    const cost1Y = calculateMA(data, 52);
    // 需要至少 260 筆才有意義；資料不足時降級顯示已有長度的 MA
    const longPeriod = data.length >= 260 ? 260 : Math.max(104, data.length - 1);
    const cost5Y = calculateMA(data, longPeriod);

    createChart('chip-cost-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電股價', data: closes, borderColor: '#3b82f6', borderWidth: 2, tension: 0.1, pointRadius: 0 },
                { label: '近1年法人成本線 (52週MA)', data: cost1Y, borderColor: '#f59e0b', borderWidth: 2, borderDash: [6, 3], tension: 0.4, pointRadius: 0 },
                { label: `長期法人底部 (${longPeriod}週MA)`, data: cost5Y, borderColor: '#ef4444', borderWidth: 2.5, tension: 0.4, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' } }
            }
        }
    });
}

function renderChipFlowChart(data) {
    // 共用 options，關鍵：intersect: false 讓區域懸停即顯示
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false }, // ← 區域懸停即顯示
        plugins: {
            legend: { position: 'top' },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw.toLocaleString()} 張`
                }
            }
        },
        scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } } }
    };

    if (!data) {
        createChart('chip-flow-chart', {
            type: 'bar',
            data: {
                labels: ['資料載入中...'],
                datasets: [{ label: '等待資料', data: [0] }]
            },
            options: commonOptions
        });
        return;
    }

    createChart('chip-flow-chart', {
        type: 'bar',
        data: {
            labels: data.labels,
            datasets: [
                {
                    label: '外資買賣超 (張)',
                    data: data.foreign,
                    backgroundColor: data.foreign.map(v => v >= 0 ? 'rgba(239,68,68,0.8)' : 'rgba(34,197,94,0.8)'),
                    borderRadius: 2
                },
                {
                    label: '投信買賣超 (張)',
                    data: data.trust,
                    backgroundColor: 'rgba(59,130,246,0.75)',
                    borderRadius: 2
                },
                {
                    label: '自營商買賣超 (張)',
                    data: data.dealer,
                    backgroundColor: 'rgba(245,158,11,0.75)',
                    borderRadius: 2
                }
            ]
        },
        options: commonOptions
    });
}

function renderChipCumulativeChart(data) {
    if (!data) {
        createChart('chip-cumulative-chart', {
            type: 'line',
            data: {
                labels: ['資料載入中...'],
                datasets: [{ label: '等待資料', data: [0], borderColor: '#64748b' }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            }
        });
        return;
    }

    const cumulative = arr => arr.reduce((series, value, index) => {
        series.push((series[index - 1] || 0) + value);
        return series;
    }, []);

    createChart('chip-cumulative-chart', {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                { label: '外資累積', data: cumulative(data.foreign), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '投信累積', data: cumulative(data.trust), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 },
                { label: '自營累積', data: cumulative(data.dealer), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 2.5, tension: 0.25, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${Math.round(ctx.raw).toLocaleString()} 張`
                    }
                }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '累積張數' } }
            }
        }
    });
}

// ─── 總經面圖表 ────────────────────────────────────────────────
function renderMacroChart(tsmData, twdData) {
    const minLength = Math.min(tsmData.length, twdData.length);
    const rTsm = tsmData.slice(-minLength);
    const rTwd = twdData.slice(-minLength);
    const labels = rTsm.map(d => `${d.date.getMonth()+1}/${d.date.getDate()}`);

    createChart('macro-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電 (2330.TW)', data: rTsm.map(d => d.close), borderColor: '#3b82f6', yAxisID: 'y', tension: 0.1, pointRadius: 0 },
                { label: 'USD/TWD 匯率', data: rTwd.map(d => d.close), borderColor: '#f59e0b', yAxisID: 'y1', tension: 0.1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y:  { type: 'linear', position: 'left',  grid: { color: 'rgba(255,255,255,0.05)' } },
                y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false } }
            }
        }
    });
}

function renderSoxAdrChart(tsmData, soxData, adrData) {
    if (!tsmData?.length || !soxData?.length || !adrData?.length) {
        console.warn('SOX/ADR 資料不足'); return;
    }

    // 以「1年前」為共同起點
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    const since = arr => {
        const f = arr.filter(d => new Date(d.date) >= cutoff);
        return f.length > 2 ? f : arr.slice(-52);
    };

    const rTsm = since(tsmData);
    const rSox = since(soxData);
    const rAdr = since(adrData);

    // ── 建立統一時間軸：以資料最多的那組為主軸，其他插值對齊 ──
    // 用最長的那組作為 labels 基準
    const master = [rTsm, rSox, rAdr].reduce((a, b) => a.length >= b.length ? a : b);
    const labels = master.map(d => {
        const dt = new Date(d.date);
        return `${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}`;
    });

    // 把任意陣列插值對齊到 master 長度
    const alignTo = (arr, masterArr) => {
        if (arr.length === masterArr.length) {
            // 長度相同，直接用
            const base = arr[0].close;
            return arr.map(d => +((d.close - base) / base * 100).toFixed(2));
        }
        // 長度不同：用線性插值對齊
        const base = arr[0].close;
        const result = [];
        for (let i = 0; i < masterArr.length; i++) {
            const targetTime = new Date(masterArr[i].date).getTime();
            // 找最接近的兩個點做插值
            let lo = arr[0], hi = arr[arr.length - 1];
            for (let j = 0; j < arr.length - 1; j++) {
                if (new Date(arr[j].date).getTime() <= targetTime &&
                    new Date(arr[j+1].date).getTime() >= targetTime) {
                    lo = arr[j]; hi = arr[j+1]; break;
                }
            }
            const t1 = new Date(lo.date).getTime();
            const t2 = new Date(hi.date).getTime();
            const frac = t2 === t1 ? 0 : (targetTime - t1) / (t2 - t1);
            const close = lo.close + (hi.close - lo.close) * frac;
            result.push(+((close - base) / base * 100).toFixed(2));
        }
        return result;
    };

    const tsmPct = alignTo(rTsm, master);
    const soxPct = alignTo(rSox, master);
    const adrPct = alignTo(rAdr, master);

    createChart('sox-adr-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: '台積電 (2330.TW)',  data: tsmPct, borderColor: '#ef4444', borderWidth: 2.5, tension: 0.1, pointRadius: 0 },
                { label: '台積電 ADR (TSM)',  data: adrPct, borderColor: '#3b82f6', borderWidth: 2,   tension: 0.1, pointRadius: 0 },
                { label: 'SOXX 半導體 ETF',  data: soxPct, borderColor: '#10b981', borderWidth: 2,   tension: 0.1, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8' } },
                tooltip: {
                    callbacks: {
                        title: items => labels[items[0].dataIndex] || '',
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw}%`
                    }
                }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', callback: v => v + '%' },
                    title: { display: true, text: '累積報酬率 (%)', color: '#94a3b8' }
                }
            }
        }
    });
}

function updateMacroSnapshot(tsmData, twdData, soxData, adrData) {
    const setText = (id, text, numericValue = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerText = text;
        if (numericValue !== null) {
            el.style.color = numericValue >= 0 ? '#ef4444' : '#22c55e';
        }
    };

    const pctReturn = (data) => {
        if (!data || data.length < 2) return null;
        const first = data[0].close;
        const last = data[data.length - 1].close;
        if (!first || !last) return null;
        return ((last - first) / first) * 100;
    };

    const tsmReturn = pctReturn(tsmData);
    const adrReturn = pctReturn(adrData);
    const soxReturn = pctReturn(soxData);

    if (tsmReturn !== null) setText('macro-tsm-return', `${tsmReturn >= 0 ? '+' : ''}${tsmReturn.toFixed(1)}%`, tsmReturn);
    if (adrReturn !== null) setText('macro-adr-return', `${adrReturn >= 0 ? '+' : ''}${adrReturn.toFixed(1)}%`, adrReturn);
    if (soxReturn !== null) setText('macro-sox-return', `${soxReturn >= 0 ? '+' : ''}${soxReturn.toFixed(1)}%`, soxReturn);

    if (tsmData.length > 2 && twdData.length > 2) {
        const minLength = Math.min(tsmData.length, twdData.length);
        const tsmReturns = toReturns(tsmData.slice(-minLength).map(d => d.close));
        const twdReturns = toReturns(twdData.slice(-minLength).map(d => d.close));
        const corr = correlation(tsmReturns, twdReturns);
        const corrEl = document.getElementById('macro-fx-corr');
        if (corrEl && Number.isFinite(corr)) {
            corrEl.innerText = corr.toFixed(2);
            corrEl.style.color = Math.abs(corr) >= 0.35 ? '#f59e0b' : '#94a3b8';
        }
    }
}

// ─── 產業面圖表 ────────────────────────────────────────────────
function renderIndustryChart() {
    createChart('industry-pie-chart', {
        type: 'doughnut',
        data: {
            labels: ['3奈米 (N3/N2)', '5奈米 (N5)', '7奈米 (N7)', '16/20奈米', '28奈米以上'],
            datasets: [{
                data: [26, 34, 16, 9, 15],
                backgroundColor: ['#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#e0f2fe'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'right' } }
        }
    });

    createChart('market-share-chart', {
        type: 'doughnut',
        data: {
            labels: ['TSMC (台積電)', 'Samsung', 'SMIC (中芯)', 'UMC (聯電)', 'GlobalFoundries', 'Others'],
            datasets: [{
                data: [61.7, 11.0, 5.7, 5.7, 5.1, 10.8],
                backgroundColor: ['#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#64748b'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: { legend: { position: 'right' } }
        }
    });

    // 平台業務收入結構
    createChart('platform-chart', {
        type: 'bar',
        data: {
            labels: ['2020', '2021', '2022', '2023', '2024', '2025', '2026(E)'],
            datasets: [
                { label: 'HPC (AI/高效能運算)', data: [33, 41, 42, 43, 51, 59, 63], backgroundColor: 'rgba(59,130,246,0.85)', borderRadius: 4 },
                { label: '智慧型手機', data: [48, 44, 38, 38, 33, 28, 26], backgroundColor: 'rgba(245,158,11,0.85)', borderRadius: 4 },
                { label: 'IoT / 汽車電子 / 其他', data: [19, 15, 20, 19, 16, 13, 11], backgroundColor: 'rgba(100,116,139,0.85)', borderRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, max: 100, title: { display: true, text: '佔比 %' } }
            }
        }
    });

    createChart('advanced-node-chart', {
        type: 'line',
        data: {
            labels: ['2021', '2022', '2023', '2024', '2025', '2026(E)'],
            datasets: [
                { label: '7nm 以下先進製程', data: [50, 53, 58, 69, 74, 78], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.14)', fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4 },
                { label: '成熟/特殊製程', data: [50, 47, 42, 31, 26, 22], borderColor: '#64748b', borderDash: [5, 4], borderWidth: 2, tension: 0.35, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '營收占比 %' } }
            }
        }
    });

    createChart('packaging-chart', {
        type: 'bar',
        data: {
            labels: ['CoWoS', 'SoIC', 'InFO', '矽光子', '特殊製程'],
            datasets: [{
                label: '策略重要性',
                data: [95, 82, 72, 64, 68],
                backgroundColor: ['#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b'],
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.03)' } }
            }
        }
    });

    createChart('competitive-radar-chart', {
        type: 'radar',
        data: {
            labels: ['先進製程', '先進封裝', '良率/量產', '客戶信任', '資本能力', '全球彈性'],
            datasets: [
                { label: 'TSMC', data: [96, 94, 95, 97, 92, 84], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.18)', pointBackgroundColor: '#ef4444' },
                { label: 'Samsung Foundry', data: [78, 70, 68, 72, 82, 76], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', pointBackgroundColor: '#3b82f6' },
                { label: 'Intel Foundry', data: [70, 66, 58, 62, 86, 80], borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', pointBackgroundColor: '#f59e0b' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { display: false, stepSize: 20 },
                    angleLines: { color: 'rgba(255,255,255,0.08)' },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    pointLabels: { color: '#cbd5e1', font: { size: 12 } }
                }
            }
        }
    });
}

// ─── 展望面圖表 ────────────────────────────────────────────────
function renderOutlookChart() {
    createChart('outlook-capex-chart', {
        type: 'bar',
        data: {
            labels: ['2021', '2022', '2023', '2024', '2025', '2026(E)', '2027(E)', '2028(E)'],
            datasets: [{
                label: '資本支出 (十億美元)',
                data: [30.0, 36.3, 30.4, 30.0, 38.0, 42.0, 46.0, 52.0],
                backgroundColor: (ctx) => {
                    const v = ctx.raw;
                    return v > 40 ? 'rgba(239,68,68,0.8)' : 'rgba(16,185,129,0.8)';
                },
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億美元 (USD B)' } } }
        }
    });

    // 長期營收預測
    createChart('outlook-revenue-chart', {
        type: 'line',
        data: {
            labels: ['2022', '2023', '2024', '2025', '2026(E)', '2027(E)', '2028(E)', '2029(E)', '2030(E)'],
            datasets: [{
                label: '年度營收 (十億台幣)',
                data: [2264, 2161, 2894, 3809, 4700, 5500, 6500, 7600, 9000],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.15)',
                fill: true,
                borderWidth: 3,
                tension: 0.4,
                pointRadius: 5,
                pointBackgroundColor: '#3b82f6'
            }, {
                label: '保守預估',
                data: [2264, 2161, 2894, 3809, 4400, 5000, 5700, 6500, 7500],
                borderColor: '#94a3b8',
                borderDash: [5, 5],
                borderWidth: 2,
                tension: 0.4,
                pointRadius: 0,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } }
            }
        }
    });

    createChart('outlook-scenario-chart', {
        type: 'line',
        data: {
            labels: ['2025', '2026(E)', '2027(E)', '2028(E)', '2029(E)', '2030(E)'],
            datasets: [
                { label: '保守：AI 放緩但製程升級延續', data: [3809, 4400, 5000, 5700, 6500, 7500], borderColor: '#94a3b8', borderDash: [5, 4], borderWidth: 2, tension: 0.35, pointRadius: 3 },
                { label: '基準：AI/HPC 持續擴產', data: [3809, 4700, 5500, 6500, 7600, 9000], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.13)', fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4 },
                { label: '樂觀：ASIC 與先進封裝供給釋放', data: [3809, 5000, 6100, 7600, 9300, 11200], borderColor: '#ef4444', borderWidth: 3, tension: 0.35, pointRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, title: { display: true, text: '十億台幣' } }
            }
        }
    });
}

// ─── 風險情境 ──────────────────────────────────────────────────
function renderRiskChart() {
    createChart('risk-radar-chart', {
        type: 'radar',
        data: {
            labels: ['AI 需求循環', '客戶集中', '先進節點良率', '海外廠成本', '匯率波動', '地緣限制'],
            datasets: [{
                label: '追蹤優先度',
                data: [88, 72, 76, 70, 62, 84],
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245,158,11,0.18)',
                pointBackgroundColor: '#f59e0b'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { display: false, stepSize: 20 },
                    angleLines: { color: 'rgba(255,255,255,0.08)' },
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    pointLabels: { color: '#cbd5e1', font: { size: 12 } }
                }
            }
        }
    });
}

// ─── 情緒分析 ──────────────────────────────────────────────────
function analyzeSentiment(news) {
    const positiveWords = ['量產', '突破', '創高', '買進', '目標價', '看好', '成長', '法說會', '獲利', '大漲', '雙增', '上修', '優於', '強勁', '受惠', 'beat', 'upgrade', 'outperform', 'record'];
    const negativeWords = ['砍單', '衰退', '延遲', '賣出', '看跌', '下修', '利空', '大跌', '外資提款', '減少', '不如預期', '放緩', 'downgrade', 'underperform', 'miss', 'cut'];

    let posCount = 0, negCount = 0;
    const posHits = new Set();
    const negHits = new Set();
    news.forEach(n => {
        const text = (n.title + ' ' + (n.summary || '')).toLowerCase();
        positiveWords.forEach(w => {
            if (text.includes(w.toLowerCase())) {
                posCount++;
                posHits.add(w);
            }
        });
        negativeWords.forEach(w => {
            if (text.includes(w.toLowerCase())) {
                negCount++;
                negHits.add(w);
            }
        });
    });

    let score = 50;
    if (posCount + negCount > 0) {
        score = 50 + ((posCount - negCount) / (posCount + negCount)) * 50;
    }

    const scoreEl = document.getElementById('sentiment-score');
    const labelEl = document.getElementById('sentiment-label');
    const needleEl = document.getElementById('sentiment-needle');

    if (scoreEl) scoreEl.innerText = score.toFixed(0);
    if (needleEl) needleEl.style.left = score + '%';

    let color = '#94a3b8', label = '中立 (Neutral)';
    if (score >= 65)      { color = '#ef4444'; label = '極度樂觀 (Bullish)'; }
    else if (score >= 55) { color = '#f87171'; label = '偏多 (Positive)'; }
    else if (score <= 35) { color = '#22c55e'; label = '極度悲觀 (Bearish)'; }
    else if (score <= 45) { color = '#4ade80'; label = '偏空 (Negative)'; }

    if (scoreEl) scoreEl.style.color = color;
    if (labelEl) { labelEl.innerText = label; labelEl.style.color = color; }

    const keywordsEl = document.getElementById('sentiment-keywords');
    if (keywordsEl) {
        const renderTags = (items, fallback) => {
            const tags = [...items];
            if (tags.length === 0) return `<span>${fallback}</span>`;
            return tags.map(item => `<span>${escapeHtml(item)}</span>`).join('');
        };

        keywordsEl.innerHTML = `
            <h4>情緒關鍵字命中</h4>
            <div class="keyword-grid">
                <div class="keyword-bucket">
                    <h5>偏多訊號 (${posCount})</h5>
                    <div class="keyword-tags">${renderTags(posHits, '暫無明顯偏多字詞')}</div>
                </div>
                <div class="keyword-bucket">
                    <h5>偏空訊號 (${negCount})</h5>
                    <div class="keyword-tags">${renderTags(negHits, '暫無明顯偏空字詞')}</div>
                </div>
            </div>
        `;
    }
}

function calculateRSI(data, period = 14) {
    const closes = data.map(d => d.close);
    const rsi = Array(closes.length).fill(null);
    if (closes.length <= period) return rsi;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }

    return rsi;
}

function calculateEMA(values, period) {
    const multiplier = 2 / (period + 1);
    const ema = Array(values.length).fill(null);
    let previous = null;

    values.forEach((value, index) => {
        if (value === null || value === undefined) return;
        if (previous === null) {
            previous = value;
        } else {
            previous = (value - previous) * multiplier + previous;
        }
        ema[index] = previous;
    });

    return ema;
}

function calculateMACD(data) {
    const closes = data.map(d => d.close);
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const dif = closes.map((_, index) => {
        if (ema12[index] === null || ema26[index] === null) return null;
        return ema12[index] - ema26[index];
    });
    const dea = calculateEMA(dif, 9);
    const histogram = dif.map((value, index) => {
        if (value === null || dea[index] === null) return null;
        return value - dea[index];
    });

    return { dif, dea, histogram };
}

function toReturns(values) {
    const returns = [];
    for (let i = 1; i < values.length; i++) {
        if (!values[i - 1] || !values[i]) continue;
        returns.push((values[i] - values[i - 1]) / values[i - 1]);
    }
    return returns;
}

function correlation(a, b) {
    const length = Math.min(a.length, b.length);
    if (length < 2) return NaN;
    const x = a.slice(-length);
    const y = b.slice(-length);
    const meanX = x.reduce((sum, value) => sum + value, 0) / length;
    const meanY = y.reduce((sum, value) => sum + value, 0) / length;
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < length; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        numerator += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }

    return numerator / Math.sqrt(denomX * denomY);
}

// ═══════════════════════════════════════════════════════════════
//  新增圖表函式
// ═══════════════════════════════════════════════════════════════

// ── 1. P/E Band 圖（基本面）────────────────────────────────────
function renderPERBandChart(perData) {
    if (!perData?.length) return;

    const labels = perData.map(r => r.date.substring(0, 7)); // YYYY-MM
    const pers   = perData.map(r => r.per);

    // 計算歷史 P/E 統計（用於畫 band）
    const validPers = pers.filter(v => v > 0 && v < 100);
    const perMean  = validPers.reduce((a, b) => a + b, 0) / validPers.length;
    const perStd   = Math.sqrt(validPers.reduce((s, v) => s + (v - perMean) ** 2, 0) / validPers.length);

    // 4條 band 線：mean ± 1std、mean ± 2std（常見法人評估區間）
    const band = (n) => Array(labels.length).fill(+(perMean + n * perStd).toFixed(1));

    createChart('per-band-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'P/E（實際）', data: pers, borderColor: '#f8fafc', borderWidth: 2, pointRadius: 0, tension: 0.1, order: 0 },
                { label: `+2σ (${(perMean + 2*perStd).toFixed(0)}x)`, data: band(2),  borderColor: '#ef4444', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
                { label: `+1σ (${(perMean + perStd).toFixed(0)}x)`,   data: band(1),  borderColor: '#f59e0b', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
                { label: `均值 (${perMean.toFixed(0)}x)`,              data: band(0),  borderColor: '#94a3b8', borderWidth: 1.5, borderDash: [6,3], pointRadius: 0, fill: false },
                { label: `-1σ (${(perMean - perStd).toFixed(0)}x)`,   data: band(-1), borderColor: '#22c55e', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
                { label: `-2σ (${(perMean - 2*perStd).toFixed(0)}x)`, data: band(-2), borderColor: '#3b82f6', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', boxWidth: 20 } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}x` } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: { ticks: { color: '#94a3b8', callback: v => v + 'x' }, grid: { color: 'rgba(255,255,255,0.05)' },
                     title: { display: true, text: '本益比 (倍)', color: '#94a3b8' } }
            }
        }
    });
}

// ── 2. 外資持股比例歷史趨勢（籌碼面）──────────────────────────
function renderShareholdingChart(data) {
    if (!data?.length) return;
    const labels = data.map(r => r.date.substring(0, 7));
    const ratios = data.map(r => r.ratio);

    createChart('shareholding-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: '外資持股比例 (%)',
                data: ratios,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.1)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` 外資持股: ${ctx.raw.toFixed(2)}%` } }
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    ticks: { color: '#94a3b8', callback: v => v + '%' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '持股比例 (%)', color: '#94a3b8' }
                }
            }
        }
    });
}

// ── 3. VIX + 台積電股價（總經面）──────────────────────────────
function renderVIXChart(tsmData, vixData) {
    if (!tsmData?.length || !vixData?.length) return;

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const tsm = tsmData.filter(d => new Date(d.date) >= cutoff);
    const vix = vixData.filter(d => new Date(d.date) >= cutoff);
    if (!tsm.length || !vix.length) return;

    // 對齊到 TSM 的時間軸
    const labels = tsm.map(d => {
        const dt = new Date(d.date);
        return `${dt.getMonth()+1}/${dt.getDate()}`;
    });

    createChart('vix-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: '台積電股價 (TWD)',
                    data: tsm.map(d => d.close),
                    borderColor: '#ef4444',
                    borderWidth: 2,
                    pointRadius: 0,
                    yAxisID: 'y',
                    tension: 0.1
                },
                {
                    label: 'VIX 恐慌指數',
                    data: (() => {
                        // 插值對齊到 TSM 時間軸
                        return tsm.map(tsmRow => {
                            const target = new Date(tsmRow.date).getTime();
                            const near = vix.reduce((a, b) =>
                                Math.abs(new Date(b.date).getTime() - target) <
                                Math.abs(new Date(a.date).getTime() - target) ? b : a
                            );
                            return near.close;
                        });
                    })(),
                    borderColor: '#f59e0b',
                    borderWidth: 2,
                    pointRadius: 0,
                    yAxisID: 'y1',
                    tension: 0.1
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8' } },
                tooltip: { callbacks: {
                    label: ctx => ctx.datasetIndex === 0
                        ? ` 台積電: NT$${ctx.raw.toLocaleString()}`
                        : ` VIX: ${ctx.raw.toFixed(1)}`
                }}
            },
            scales: {
                x: { ticks: { maxTicksLimit: 12, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    type: 'linear', position: 'left',
                    ticks: { color: '#ef4444', callback: v => 'NT$' + v.toLocaleString() },
                    grid: { color: 'rgba(255,255,255,0.05)' }
                },
                y1: {
                    type: 'linear', position: 'right',
                    ticks: { color: '#f59e0b' },
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: 'VIX', color: '#f59e0b' }
                }
            }
        }
    });
}

// ── 5. 外資法人目標價（消息面）─────────────────────────────────
// 公開資料：各大外資最新目標價（截至 2026 Q1）
const ANALYST_TARGETS = [
    { firm: 'Morgan Stanley', rating: 'Overweight', target: 2200, date: '2026-05' },
    { firm: 'Goldman Sachs',  rating: 'Buy',        target: 2400, date: '2026-04' },
    { firm: 'JP Morgan',      rating: 'Overweight', target: 2350, date: '2026-04' },
    { firm: 'CLSA',           rating: 'Buy',        target: 2500, date: '2026-03' },
    { firm: 'UBS',            rating: 'Buy',        target: 2100, date: '2026-05' },
    { firm: 'Citi',           rating: 'Buy',        target: 2300, date: '2026-04' },
    { firm: 'Bernstein',      rating: 'Outperform', target: 2450, date: '2026-03' },
    { firm: 'Macquarie',      rating: 'Outperform', target: 2600, date: '2026-05' },
    { firm: 'HSBC',           rating: 'Buy',        target: 2250, date: '2026-04' },
    { firm: 'Deutsche Bank',  rating: 'Buy',        target: 2180, date: '2026-03' },
];

function renderAnalystTargets(currentPrice) {
    const el = document.getElementById('analyst-targets');
    if (!el) return;

    const sorted = [...ANALYST_TARGETS].sort((a, b) => b.target - a.target);
    const avgTarget = Math.round(sorted.reduce((s, r) => s + r.target, 0) / sorted.length);
    const upside = currentPrice ? ((avgTarget - currentPrice) / currentPrice * 100).toFixed(1) : null;

    el.innerHTML = `
        <h4>外資法人目標價（截至 2026 Q2）</h4>
        <p class="text-muted" style="margin-bottom:16px;">
            共 ${sorted.length} 家機構，平均目標價 <strong style="color:#3b82f6">NT$${avgTarget.toLocaleString()}</strong>
            ${upside ? `，較現價潛在 ${upside > 0 ? '+' : ''}${upside}%` : ''}
        </p>
        <div style="overflow-x:auto;">
            <table class="data-table">
                <thead>
                    <tr><th>機構</th><th>評級</th><th>目標價 (NT$)</th><th>vs 現價</th><th>更新</th></tr>
                </thead>
                <tbody>
                    ${sorted.map(r => {
                        const diff = currentPrice ? ((r.target - currentPrice) / currentPrice * 100).toFixed(1) : null;
                        const color = diff > 0 ? 'var(--up-color)' : 'var(--down-color)';
                        const ratingColor = r.rating.includes('Out') || r.rating === 'Buy' || r.rating === 'Overweight'
                            ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
                        return `<tr>
                            <td><strong>${r.firm}</strong></td>
                            <td><span style="background:${ratingColor};padding:2px 8px;border-radius:4px;font-size:12px;">${r.rating}</span></td>
                            <td style="font-weight:600">NT$${r.target.toLocaleString()}</td>
                            <td style="color:${color};font-weight:600">${diff ? (diff > 0 ? '+' : '') + diff + '%' : '--'}</td>
                            <td style="color:var(--text-secondary);font-size:12px">${r.date}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// ── 6. 互動估值計算機（風險面）─────────────────────────────────
function renderValuationCalculator() {
    const el = document.getElementById('valuation-calculator');
    if (!el) return;

    el.innerHTML = `
        <h4>互動式估值計算機</h4>
        <p class="text-muted" style="margin-bottom:20px;">拖動滑桿即時計算合理股價區間</p>
        <div style="display:grid;gap:20px;">
            <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                    <label style="color:var(--text-secondary);font-size:14px;">預估 EPS (NT$/股)</label>
                    <span id="calc-eps-val" style="color:#3b82f6;font-weight:600">88</span>
                </div>
                <input type="range" id="calc-eps" min="60" max="140" value="88" step="2"
                    style="width:100%;accent-color:#3b82f6;cursor:pointer"
                    oninput="updateCalc()">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:4px;">
                    <span>保守 NT$60</span><span>樂觀 NT$140</span>
                </div>
            </div>
            <div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                    <label style="color:var(--text-secondary);font-size:14px;">本益比 P/E (倍)</label>
                    <span id="calc-pe-val" style="color:#f59e0b;font-weight:600">24x</span>
                </div>
                <input type="range" id="calc-pe" min="14" max="40" value="24" step="1"
                    style="width:100%;accent-color:#f59e0b;cursor:pointer"
                    oninput="updateCalc()">
                <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:4px;">
                    <span>14x</span><span>40x</span>
                </div>
            </div>
            <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:12px;padding:20px;text-align:center;">
                <div style="color:var(--text-secondary);font-size:13px;margin-bottom:8px;">合理價格估算</div>
                <div id="calc-result" style="font-size:48px;font-weight:700;color:#f8fafc">NT$2,112</div>
                <div id="calc-range" style="color:var(--text-secondary);font-size:13px;margin-top:8px;">保守 NT$1,760 ～ 樂觀 NT$2,640</div>
                <div id="calc-updown" style="font-size:14px;margin-top:8px;font-weight:600"></div>
            </div>
        </div>
    `;
    updateCalc();
}

function updateCalc() {
    const eps = parseFloat(document.getElementById('calc-eps')?.value || 88);
    const pe  = parseFloat(document.getElementById('calc-pe')?.value  || 24);
    const fair = Math.round(eps * pe);
    const low  = Math.round(eps * (pe * 0.8));
    const high = Math.round(eps * (pe * 1.2));

    const epsEl = document.getElementById('calc-eps-val');
    const peEl  = document.getElementById('calc-pe-val');
    const resEl = document.getElementById('calc-result');
    const ranEl = document.getElementById('calc-range');
    const udEl  = document.getElementById('calc-updown');

    if (epsEl) epsEl.textContent = `NT$${eps}`;
    if (peEl)  peEl.textContent  = `${pe}x`;
    if (resEl) resEl.textContent = `NT$${fair.toLocaleString()}`;
    if (ranEl) ranEl.textContent = `保守 NT$${low.toLocaleString()} ～ 樂觀 NT$${high.toLocaleString()}`;

    // 對比現價
    const curEl = document.getElementById('current-price');
    const cur   = curEl ? parseFloat(curEl.textContent.replace(/,/g, '')) : null;
    if (udEl && cur && !isNaN(cur)) {
        const diff = ((fair - cur) / cur * 100).toFixed(1);
        udEl.textContent = `較現價 ${diff > 0 ? '+' : ''}${diff}%`;
        udEl.style.color = diff > 0 ? 'var(--up-color)' : 'var(--down-color)';
    }
}

// ── 股息歷史 + 殖利率（基本面）────────────────────────────────
function renderDividendChart(data) {
    if (!data?.length) return;
    const labels = data.map(r => r.year);
    const cash   = data.map(r => +r.cash.toFixed(2));

    // 殖利率 = 全年股息 / 年均股價（更合理，非年底收盤）
    // 年均股價（用於殖利率計算，比年底收盤更合理）
    const avgPrices = {
        '2018':215, '2019':270, '2020':400, '2021':580,
        '2022':500, '2023':535, '2024':820, '2025':1200
    };
    const yields = data.map(r => {
        const p = avgPrices[r.year];
        return p ? +((r.cash / p) * 100).toFixed(2) : null;
    });

    createChart('dividend-chart', {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: '現金股息 (NT$/股)',
                    data: cash,
                    backgroundColor: 'rgba(59,130,246,0.7)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    yAxisID: 'y',
                    order: 1
                },
                {
                    label: '殖利率 (%)',
                    data: yields,
                    type: 'line',
                    borderColor: '#f59e0b',
                    borderWidth: 2,
                    pointRadius: 4,
                    tension: 0.3,
                    yAxisID: 'y1',
                    order: 0
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8' } },
                tooltip: { callbacks: {
                    label: ctx => ctx.datasetIndex === 0
                        ? ` 現金股息: NT$${ctx.raw}`
                        : ` 殖利率: ${ctx.raw}%`
                }}
            },
            scales: {
                x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    position: 'left',
                    ticks: { color: '#3b82f6', callback: v => 'NT$' + v },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '現金股息 (NT$)', color: '#3b82f6' }
                },
                y1: {
                    position: 'right',
                    ticks: { color: '#f59e0b', callback: v => v + '%' },
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: '殖利率 (%)', color: '#f59e0b' }
                }
            }
        }
    });
}

// ── 融資融券餘額（籌碼面）─────────────────────────────────────
function renderMarginChart(data) {
    if (!data?.length) return;

    // FinMind 真實欄位：MarginPurchaseBalance, ShortSaleBalance
    const sampled = data.length > 60 ? data.filter((_, i) => i % 5 === 0) : data;
    const labels  = sampled.map(r => r.date.substring(5));
    const margin  = sampled.map(r => r.marginBalance || 0); // 張
    const shortS  = sampled.map(r => r.shortBalance  || 0); // 張

    createChart('margin-chart', {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: '融資餘額 (張)',
                    data: margin,
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.08)',
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yMargin'
                },
                {
                    label: '融券餘額 (張)',
                    data: shortS,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34,197,94,0.08)',
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yShort'
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8' } },
                tooltip: { callbacks: {
                    label: ctx => ` ${ctx.dataset.label}: ${ctx.raw?.toLocaleString() ?? '--'} 張`
                }}
            },
            scales: {
                x: { ticks: { maxTicksLimit: 10, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                yMargin: {
                    type: 'linear',
                    position: 'left',
                    ticks: { color: '#ef4444', callback: v => v.toLocaleString() },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '融資 (張)', color: '#ef4444' }
                },
                yShort: {
                    type: 'linear',
                    position: 'right',
                    ticks: { color: '#22c55e', callback: v => v.toLocaleString() },
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: '融券 (張)', color: '#22c55e' }
                }
            }
        }
    });
}

// ── 客戶集中度（產業面）───────────────────────────────────────
// 資料來源：台積電 2025 年報（公開）
function renderCustomerConcentration() {
    // canvas 存在即可，不需要獨立容器
    if (!document.getElementById('customer-pie-chart')) return;

    // Apple/NVIDIA/AMD/Qualcomm/其他（依 2025 年報近似佔比）
    const customers = [
        { name: 'Apple',    pct: 25, color: '#3b82f6', note: 'A18/M4 系列晶片' },
        { name: 'NVIDIA',   pct: 17, color: '#10b981', note: 'Blackwell GB200' },
        { name: 'AMD',      pct: 9,  color: '#f59e0b', note: 'MI300X / EPYC' },
        { name: 'Qualcomm', pct: 7,  color: '#a78bfa', note: 'Snapdragon 8 Gen 4' },
        { name: 'Broadcom', pct: 6,  color: '#fb923c', note: 'AI ASIC / 網路晶片' },
        { name: 'Intel',    pct: 5,  color: '#94a3b8', note: 'Lunar Lake 外包' },
        { name: '其他',     pct: 31, color: '#475569', note: '車用、IoT、HPC 等' },
    ];

    const total = customers.reduce((s, c) => s + c.pct, 0);

    createChart('customer-pie-chart', {
        type: 'doughnut',
        data: {
            labels: customers.map(c => c.name),
            datasets: [{
                data: customers.map(c => c.pct),
                backgroundColor: customers.map(c => c.color),
                borderColor: 'rgba(11,15,25,0.8)',
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#94a3b8', padding: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const c = customers[ctx.dataIndex];
                            return ` ${c.name}: ${c.pct}% — ${c.note}`;
                        }
                    }
                }
            },
            cutout: '60%'
        }
    });

    // 文字補充
    const noteEl = document.getElementById('customer-note');
    if (noteEl) {
        noteEl.innerHTML = `
            <p class="source-note">
                資料來源：台積電 2025 年報及法說會。前五大客戶合計約佔營收 <strong>64%</strong>，
                客戶集中度高，Apple 佔比最大（約 25%），NVIDIA AI 晶片訂單快速成長，
                已成為第二大客戶。<br>
                <span style="color:var(--text-secondary);font-size:12px">* 實際比例為估算，各季有所波動</span>
            </p>
        `;
    }
}

// ── 情境壓力測試（風險面）─────────────────────────────────────
// 三種情境：熊市、基準、牛市的 EPS × P/E 路徑
// ── 情境壓力測試（風險面）────────────────────────────────────
// 邏輯：固定 EPS 情境（悲觀/基準/樂觀），三條 P/E 線（熊/基準/牛）
// 2025 用實際數字，2026 起為預估

const SCENARIO_DATA = {
    // EPS 預估（三種假設）
    eps: {
        bear: { label: '悲觀 EPS', values: { 2025:82, 2026:88, 2027:92, 2028:95, 2029:98,  2030:100 } },
        base: { label: '基準 EPS', values: { 2025:82, 2026:98, 2027:115,2028:132,2029:150, 2030:168 } },
        bull: { label: '樂觀 EPS', values: { 2025:82, 2026:112,2027:142,2028:175,2029:210, 2030:248 } },
    },
    // P/E 假設（三種市場估值）
    pe: {
        bear: { label: '熊市 P/E（15x）',   val: 15, color: '#ef4444' },
        base: { label: '基準 P/E（22x）',   val: 22, color: '#3b82f6' },
        bull: { label: '牛市 P/E（28x）',   val: 28, color: '#10b981' },
    },
    // 2025 實際年末股價（已知）
    actual2025: 1490
};

let _scenarioEpsMode = 'base'; // 目前選取的 EPS 情境

function renderScenarioChart(epsMode) {
    epsMode = epsMode || _scenarioEpsMode;
    _scenarioEpsMode = epsMode;

    const el = document.getElementById('scenario-chart');
    if (!el) return;

    // 建立按鈕 UI（只建一次）
    if (!document.getElementById('scenario-buttons')) {
        const btnGroup = document.createElement('div');
        btnGroup.id = 'scenario-buttons';
        btnGroup.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;';
        ['bear','base','bull'].forEach(mode => {
            const eps = SCENARIO_DATA.eps[mode];
            const colors = {bear:'#ef4444',base:'#3b82f6',bull:'#10b981'};
            const btn = document.createElement('button');
            btn.id = `scenario-btn-${mode}`;
            btn.textContent = eps.label;
            btn.style.cssText = `padding:6px 14px;border-radius:6px;border:1px solid ${colors[mode]};
                background:${mode===epsMode?colors[mode]:'transparent'};
                color:${mode===epsMode?'#fff':colors[mode]};
                cursor:pointer;font-size:13px;font-family:inherit;transition:all 0.2s;`;
            btn.onclick = () => renderScenarioChart(mode);
            btnGroup.appendChild(btn);
        });
        // 插到 canvas 前
        const canvas = document.getElementById('scenario-canvas');
        if (canvas?.parentNode) canvas.parentNode.insertBefore(btnGroup, canvas);
    } else {
        // 更新按鈕樣式
        ['bear','base','bull'].forEach(mode => {
            const colors = {bear:'#ef4444',base:'#3b82f6',bull:'#10b981'};
            const btn = document.getElementById(`scenario-btn-${mode}`);
            if (!btn) return;
            btn.style.background = mode === epsMode ? colors[mode] : 'transparent';
            btn.style.color      = mode === epsMode ? '#fff' : colors[mode];
        });
    }

    const epsData   = SCENARIO_DATA.eps[epsMode];
    const peScenes  = SCENARIO_DATA.pe;
    const years     = [2025, 2026, 2027, 2028, 2029, 2030];
    const labels    = years.map((y,i) => i === 0 ? `${y}（實際）` : `${y}E`);

    // 現價參考線
    const currentPrice = parseFloat(
        document.getElementById('current-price')?.textContent?.replace(/,/g,'') || '2310'
    );

    const datasets = [
        // 三條 P/E 線
        ...Object.values(peScenes).map(pe => ({
            label: pe.label,
            data: years.map((y, i) => {
                if (i === 0) return SCENARIO_DATA.actual2025; // 2025 用實際值
                return Math.round(epsData.values[y] * pe.val);
            }),
            borderColor: pe.color,
            borderWidth: 2.5,
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: 0.3,
            fill: false,
        })),
        // 當前股價水平線（灰色）
        {
            label: `現價 NT$${currentPrice.toLocaleString()}`,
            data: years.map(() => currentPrice),
            borderColor: 'rgba(148,163,184,0.6)',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
        }
    ];

    createChart('scenario-canvas', {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', boxWidth: 20 } },
                tooltip: { callbacks: {
                    title: items => labels[items[0].dataIndex],
                    label: ctx => {
                        if (ctx.datasetIndex >= 3) return ` ${ctx.dataset.label}`;
                        const pe = Object.values(peScenes)[ctx.datasetIndex];
                        const y = years[ctx.dataIndex];
                        const eps = ctx.dataIndex === 0 ? '（實際）' : `EPS NT$${epsData.values[y]} × ${pe.val}x`;
                        return ` ${pe.label}: NT$${ctx.raw.toLocaleString()} ${eps}`;
                    }
                }}
            },
            scales: {
                x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y: {
                    ticks: { color: '#94a3b8', callback: v => 'NT$' + v.toLocaleString() },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '目標股價 (NT$)', color: '#94a3b8' }
                }
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  相關性熱力圖（總經面）
// ═══════════════════════════════════════════════════════════════
function renderCorrelationHeatmap(tsmData, soxData, adrData, spyData) {
    const canvas = document.getElementById('correlation-heatmap');
    if (!canvas) return;

    // 計算週報酬率序列
    const weeklyReturns = (data) => {
        if (!data?.length) return [];
        return data.slice(1).map((r, i) => {
            const prev = data[i].close;
            return prev > 0 ? (r.close - prev) / prev : 0;
        });
    };

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const since = arr => (arr || []).filter(d => new Date(d.date) >= cutoff);

    const series = {
        '台積電\n(2330)': weeklyReturns(since(tsmData)),
        'SOXX\n半導體': weeklyReturns(since(soxData)),
        'TSM\nADR':      weeklyReturns(since(adrData)),
        'SPY\nS&P500':   weeklyReturns(since(spyData)),
    };

    const names  = Object.keys(series);
    const n      = names.length;

    // 計算相關係數矩陣
    const corr = (a, b) => {
        const len = Math.min(a.length, b.length);
        if (len < 5) return 0;
        const ax = a.slice(-len), bx = b.slice(-len);
        const ma = ax.reduce((s, v) => s + v, 0) / len;
        const mb = bx.reduce((s, v) => s + v, 0) / len;
        let num = 0, da = 0, db = 0;
        for (let i = 0; i < len; i++) {
            num += (ax[i] - ma) * (bx[i] - mb);
            da  += (ax[i] - ma) ** 2;
            db  += (bx[i] - mb) ** 2;
        }
        return da * db > 0 ? +(num / Math.sqrt(da * db)).toFixed(3) : 0;
    };

    const matrix = names.map(r => names.map(c => corr(series[r], series[c])));

    // 用 Chart.js 的 bubble chart 模擬熱力圖
    const data_pts = [];
    matrix.forEach((row, ri) => {
        row.forEach((val, ci) => {
            data_pts.push({ x: ci, y: n - 1 - ri, v: val });
        });
    });

    // 顏色插值：-1=藍，0=灰，+1=紅
    const corrColor = (v, alpha = 0.85) => {
        if (v >= 0) {
            const r = Math.round(239 * v + 30 * (1 - v));
            const g = Math.round(68  * v + 41 * (1 - v));
            const b = Math.round(68  * v + 59 * (1 - v));
            return `rgba(${r},${g},${b},${alpha})`;
        } else {
            const t = -v;
            const r = Math.round(59  * (1 - t) + 30 * t);
            const g = Math.round(130 * (1 - t) + 41 * t);
            const b = Math.round(246 * (1 - t) + 59 * t);
            return `rgba(${r},${g},${b},${alpha})`;
        }
    };

    createChart('correlation-heatmap', {
        type: 'bubble',
        data: {
            datasets: [{
                data: data_pts.map(p => ({
                    x: p.x, y: p.y, r: 38,
                    v: p.v
                })),
                backgroundColor: data_pts.map(p => corrColor(p.v)),
                borderColor:     data_pts.map(p => corrColor(p.v, 1)),
                borderWidth: 1,
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const p = data_pts[ctx.dataIndex];
                            const rName = names[n - 1 - Math.round(ctx.parsed.y)];
                            const cName = names[Math.round(ctx.parsed.x)];
                            return ` ${rName.replace('\n','  ')} ↔ ${cName.replace('\n','  ')}: ${p.v.toFixed(3)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear', min: -0.5, max: n - 0.5,
                    ticks: {
                        stepSize: 1, color: '#94a3b8',
                        callback: v => names[Math.round(v)]?.replace('\n', ' ') ?? ''
                    },
                    grid: { display: false }
                },
                y: {
                    type: 'linear', min: -0.5, max: n - 0.5,
                    ticks: {
                        stepSize: 1, color: '#94a3b8',
                        callback: v => names[n - 1 - Math.round(v)]?.replace('\n', ' ') ?? ''
                    },
                    grid: { display: false }
                }
            },
            // 在 bubble 內畫相關係數數字
            animation: {
                onComplete: function() {
                    const chart = this;
                    const ctx2  = chart.ctx;
                    ctx2.save();
                    ctx2.font = 'bold 13px Inter, sans-serif';
                    ctx2.textAlign = 'center';
                    ctx2.textBaseline = 'middle';
                    chart.data.datasets[0].data.forEach((pt, i) => {
                        const meta  = chart.getDatasetMeta(0);
                        const elem  = meta.data[i];
                        if (!elem) return;
                        const val   = data_pts[i].v;
                        ctx2.fillStyle = Math.abs(val) > 0.5 ? '#fff' : '#cbd5e1';
                        ctx2.fillText(val.toFixed(2), elem.x, elem.y);
                    });
                    ctx2.restore();
                }
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  製程節點競爭對手比較（展望面）
// ═══════════════════════════════════════════════════════════════
function renderProcessRoadmapChart() {
    const canvas = document.getElementById('process-roadmap-chart');
    if (!canvas) return;

    // 資料來源：各公司技術路線圖公開資訊（截至 2026 Q2）
    // 以「電晶體密度 MTr/mm²」作為 Y 軸，量產年份作為 X 軸
    const roadmap = {
        'TSMC': [
            { year: 2020, node: '5nm (N5)',   density: 171.3, status: 'done' },
            { year: 2022, node: '4nm (N4)',   density: 192,   status: 'done' },
            { year: 2022, node: '3nm (N3)',   density: 292,   status: 'done' },
            { year: 2025, node: '2nm (N2)',   density: 380,   status: 'done' },
            { year: 2026, node: 'A16',        density: 450,   status: 'current' },
            { year: 2028, node: 'A14',        density: 560,   status: 'future' },
        ],
        'Samsung': [
            { year: 2021, node: '5nm',        density: 127,   status: 'done' },
            { year: 2022, node: '4nm',        density: 149,   status: 'done' },
            { year: 2022, node: '3nm (GAA)',  density: 228,   status: 'done' },
            { year: 2025, node: '2nm (GAA)',  density: 300,   status: 'done' },
            { year: 2027, node: '1.4nm',      density: 420,   status: 'future' },
        ],
        'Intel': [
            { year: 2021, node: 'Intel 7',    density: 100,   status: 'done' },
            { year: 2023, node: 'Intel 4',    density: 151,   status: 'done' },
            { year: 2024, node: 'Intel 3',    density: 238,   status: 'done' },
            { year: 2025, node: '14A (2nm級)', density: 260,  status: 'current' },
            { year: 2027, node: '10A',        density: 380,   status: 'future' },
        ],
    };

    const colors = {
        'TSMC':    { done: '#3b82f6', current: '#60a5fa', future: 'rgba(59,130,246,0.4)' },
        'Samsung': { done: '#10b981', current: '#34d399', future: 'rgba(16,185,129,0.4)' },
        'Intel':   { done: '#f59e0b', current: '#fbbf24', future: 'rgba(245,158,11,0.4)' },
    };

    const datasets = Object.entries(roadmap).map(([company, nodes]) => ({
        label: company,
        data: nodes.map(n => ({ x: n.year, y: n.density, node: n.node, status: n.status })),
        borderColor: colors[company].done,
        backgroundColor: nodes.map(n => colors[company][n.status]),
        pointRadius: nodes.map(n => n.status === 'current' ? 10 : 7),
        pointHoverRadius: 12,
        borderWidth: 2,
        tension: 0.3,
        fill: false,
        pointStyle: nodes.map(n => n.status === 'future' ? 'triangle' : 'circle'),
    }));

    createChart('process-roadmap-chart', {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'point', intersect: true },
            plugins: {
                legend: { position: 'top', labels: { color: '#94a3b8', padding: 20 } },
                tooltip: {
                    callbacks: {
                        title: ctx => `${ctx[0].dataset.label} — ${ctx[0].raw.node}`,
                        label: ctx => [
                            ` 量產年份: ${ctx.raw.x}`,
                            ` 電晶體密度: ${ctx.raw.y} MTr/mm²`,
                            ` 狀態: ${{ done: '已量產', current: '量產中/規劃量產', future: '未來規劃' }[ctx.raw.status]}`
                        ]
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear', min: 2019.5, max: 2028.5,
                    ticks: { stepSize: 1, color: '#94a3b8', callback: v => Number.isInteger(v) ? v : '' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '量產年份', color: '#94a3b8' }
                },
                y: {
                    ticks: { color: '#94a3b8', callback: v => v + ' MTr' },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    title: { display: true, text: '電晶體密度 (MTr/mm²)', color: '#94a3b8' }
                }
            }
        }
    });
}
