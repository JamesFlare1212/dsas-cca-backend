import { initializeApiExplorer } from './docs-client.ts';

export const apiDocs = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DSAS CCA API 文档</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.65; }
    body { max-width: 960px; margin: auto; padding: 24px; }
    h1, h2, h3 { line-height: 1.3; }
    h2 { margin-top: 2.5rem; }
    a { color: light-dark(#1657b8, #92bcff); }
    code, pre { font-family: ui-monospace, monospace; }
    code { overflow-wrap: anywhere; }
    pre { padding: 16px; overflow-x: auto; background: light-dark(#f2f4f7, #20242b); border-radius: 8px; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #8886; }
    nav ul { display: flex; flex-wrap: wrap; gap: 8px 24px; padding-left: 20px; }
    :root { --panel: light-dark(#f7f9fc, #181c23); --border: light-dark(#d4dbe7, #404959); }
    section { scroll-margin-top: 24px; }
    .explorer { margin-top: 32px; padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
    .explorer h2 { margin-top: 0; }
    fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    legend { margin-bottom: 12px; font-weight: 600; }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    input, select, button { box-sizing: border-box; font: inherit; border: 1px solid var(--border); border-radius: 6px; }
    input, select { width: 100%; padding: 9px 12px; background: light-dark(#fff, #232a35); color: inherit; }
    input::placeholder { color: light-dark(#636e80, #a5afc0); }
    button { min-height: 44px; padding: 8px 16px; background: light-dark(#fff, #232a35); color: inherit; cursor: pointer; }
    button.primary { background: light-dark(#1657b8, #92bcff); color: light-dark(#fff, #10213b); border-color: transparent; }
    button:disabled { opacity: .5; cursor: default; }
    :focus-visible { outline: 3px solid light-dark(#1657b8, #92bcff); outline-offset: 3px; }
    .parameters { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 20px 0; }
    [hidden] { display: none !important; }
    .hint { color: light-dark(#536078, #adb8cb); font-size: .9rem; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 20px; }
    .url { display: block; padding: 12px; border: 1px solid var(--border); border-radius: 6px; overflow-wrap: anywhere; }
    .result { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
    #response-status { font-weight: 600; }
    [data-state="success"] { color: light-dark(#17653a, #78d6a1); }
    [data-state="error"] { color: light-dark(#a32132, #ff9fae); }
    [data-state="pending"] { color: light-dark(#765600, #e9cb78); }
    .result pre { max-height: 560px; white-space: pre-wrap; overflow-wrap: anywhere; }
    summary { cursor: pointer; font-weight: 600; }
    @media (max-width: 520px) { body { padding: 16px; } .explorer { padding: 16px; } }
  </style>
</head>
<body>
<header>
  <h1>DSAS CCA API 文档</h1>
  <p>接口前缀：<code>/v1</code>。所有数据接口使用 <code>GET</code>，返回 JSON。
    以下路径均相对于当前服务地址；示例数据仅用于说明结构。</p>
  <p><a href="#explorer">在线调试：填写参数并发送真实请求 ↓</a></p>
  <nav aria-label="文档目录"><ul>
    <li><a href="#list">活动列表</a></li>
    <li><a href="#counts">分类与学年</a></li>
    <li><a href="#detail">活动详情</a></li>
    <li><a href="#staff">教职工</a></li>
    <li><a href="#metadata">响应头与缓存</a></li>
    <li><a href="#errors">错误</a></li>
    <li><a href="#operations">健康检查与指标</a></li>
  </ul></nav>
</header>
<main>
  <section id="explorer" class="explorer" aria-labelledby="explorer-title">
    <h2 id="explorer-title">在线调试</h2>
    <p>请求发送到当前服务。选择接口、填写参数后，点击「发送请求」查看实际响应。
      详情与教职工接口可能触发上游采集，所有请求遵循服务的限流与缓存规则。</p>
    <noscript><p>在线调试需要启用 JavaScript。下方接口说明和示例仍可阅读。</p></noscript>
    <form id="api-explorer" aria-busy="false">
      <fieldset id="request-fields" disabled>
        <label for="request-endpoint">接口</label>
        <select id="request-endpoint">
          <option value="/v1/activity/list">GET /v1/activity/list — 活动列表</option>
          <option value="/v1/activity/category">GET /v1/activity/category — 分类统计</option>
          <option value="/v1/activity/academicYear">GET /v1/activity/academicYear — 学年统计</option>
          <option value="/v1/activity/:activityId">GET /v1/activity/:activityId — 活动详情</option>
          <option value="/v1/staffs">GET /v1/staffs — 教职工</option>
          <option value="/health/live">GET /health/live — 存活检查</option>
          <option value="/health/ready">GET /health/ready — 就绪检查</option>
          <option value="/metrics">GET /metrics — 指标</option>
        </select>
        <fieldset id="list-filters" class="parameters" aria-describedby="filter-hint">
          <legend>查询参数（可选）</legend>
          <div><label for="request-category">category</label><input id="request-category" name="category" maxlength="200" placeholder="分类名称"></div>
          <div><label for="request-year">academicYear</label><input id="request-year" name="academicYear" pattern="[0-9]{4}/[0-9]{4}" placeholder="2026/2027"></div>
          <div><label for="request-grade">grade</label><input id="request-grade" name="grade" type="number" min="-2" max="12" step="1" placeholder="-2 至 12"></div>
          <div><label for="request-led">isStudentLed</label><select id="request-led" name="isStudentLed"><option value="">不筛选</option><option value="true">true</option><option value="false">false</option></select></div>
          <div><label for="request-limit">limit</label><input id="request-limit" name="limit" type="number" min="1" max="500" step="1" placeholder="不限制条数"></div>
          <div><label for="request-offset">offset</label><input id="request-offset" name="offset" type="number" min="0" max="999999" step="1" placeholder="0"></div>
        </fieldset>
        <p id="filter-hint" class="hint">留空的参数不会发送。grade：KG1=-2、KG2=-1、KG3=0，G1–G12=1–12。</p>
        <fieldset id="detail-parameters" class="parameters" hidden disabled>
          <legend>路径参数</legend>
          <div><label for="request-activity-id">activityId（必填）</label><input id="request-activity-id" inputmode="numeric" pattern="[0-9]{1,9}" maxlength="9" required placeholder="例如 7095"></div>
        </fieldset>
      </fieldset>
      <h3>请求 URL</h3>
      <code id="request-url" class="url">启用 JavaScript 后预览请求 URL。</code>
      <div class="actions">
        <button id="request-send" class="primary" type="submit" disabled>发送请求</button>
        <button id="request-cancel" type="button" disabled>取消请求</button>
        <button id="request-reset" type="reset" disabled>重置参数</button>
        <button id="copy-curl" type="button">复制 cURL</button>
        <span id="copy-status" class="hint" role="status"></span>
      </div>
    </form>
    <details><summary>cURL 命令</summary><pre><code id="request-curl">启用 JavaScript 后生成 cURL。</code></pre></details>
    <div class="result">
      <h3>实际响应</h3>
      <p id="response-status" role="status" aria-live="polite">尚未发送请求</p>
      <code id="response-url"></code>
      <details><summary>响应头</summary><pre id="response-headers" tabindex="0"></pre></details>
      <pre id="response-body" tabindex="0" aria-label="响应体">点击「发送请求」后在此查看响应。</pre>
    </div>
  </section>
  <section id="list">
    <h2>活动列表</h2>
    <p><a href="/v1/activity/list"><code>GET /v1/activity/list</code></a></p>
    <p>返回以活动 ID 为键、仅包含名称和图片的对象。缺失图片为 <code>""</code>。
      列表读取已缓存数据，空缓存返回 <code>{}</code>。</p>
    <pre><code>{
  "7095": { "name": "Science Club", "photo": "https://images.example.org/science.avif" },
  "7096": { "name": "Chess Club", "photo": "" }
}</code></pre>
    <h3>可选查询参数</h3>
    <div class="table-scroll"><table>
      <thead><tr><th scope="col">参数</th><th scope="col">规则</th></tr></thead>
      <tbody>
        <tr><td><code>category</code></td><td>已缓存的分类名称，长度 1–200。</td></tr>
        <tr><td><code>academicYear</code></td><td>相邻年份组成的 YYYY/YYYY，例如 2026/2027，须存在于缓存。</td></tr>
        <tr><td><code>grade</code></td><td>整数 -2–12；KG1=-2、KG2=-1、KG3=0，G1–G12=1–12。</td></tr>
        <tr><td><code>isStudentLed</code></td><td>字面量 <code>true</code> 或 <code>false</code>。</td></tr>
        <tr><td><code>limit</code></td><td>整数 1–500；省略时不限制条数。</td></tr>
        <tr><td><code>offset</code></td><td>整数 0–999999，默认 0。</td></tr>
      </tbody>
    </table></div>
    <p>筛选条件可组合。结果按活动 ID 数值升序排列，先筛选再分页。
      <code>X-Total-Count</code> 为分页前的匹配数量。重复参数或格式错误返回 400；
      分类、学年不存在时分别附带 <code>availableCategories</code> 或 <code>availableAcademicYears</code>。</p>
    <p>示例：<a href="/v1/activity/list?grade=7&amp;isStudentLed=true&amp;limit=50&amp;offset=0"><code>/v1/activity/list?grade=7&amp;isStudentLed=true&amp;limit=50&amp;offset=0</code></a></p>
  </section>
  <section id="counts">
    <h2>分类与学年</h2>
    <p><a href="/v1/activity/category"><code>GET /v1/activity/category</code></a>：分类到活动数量的映射。</p>
    <pre><code>{ "Club": 12, "Sport": 8 }</code></pre>
    <p><a href="/v1/activity/academicYear"><code>GET /v1/activity/academicYear</code></a>：学年到活动数量的映射。</p>
    <pre><code>{ "2026/2027": 20 }</code></pre>
    <p>两者均基于已缓存数据聚合，空缓存返回 <code>{}</code>。</p>
  </section>
  <section id="detail">
    <h2>活动详情</h2>
    <p><code>GET /v1/activity/:activityId</code>，其中 <code>activityId</code> 为 1–9 位数字，前导零会被移除。</p>
    <p>返回完整活动对象，<code>lastCheck</code> 和 <code>cache</code> 元数据位于同一层。
      缺失的可空标量为 <code>null</code>，集合为数组。</p>
    <pre><code>{
  "id": "7095",
  "name": "Science Club",
  "academicYear": "2026/2027",
  "category": "Club",
  "description": "Weekly science activities.",
  "descriptionZh": "每周科学活动。",
  "photo": null,
  "duration": { "startDate": null, "endDate": null, "isRecurringWeekly": true },
  "grades": { "min": "7", "max": "12" },
  "isPreSignup": null,
  "isStudentLed": false,
  "materials": [],
  "meeting": {
    "day": "Monday", "startTime": "15:30", "endTime": "16:30",
    "location": { "block": null, "room": "Lab", "site": null }
  },
  "meetings": [{
    "day": "Monday", "startTime": "15:30", "endTime": "16:30",
    "location": { "block": null, "room": "Lab", "site": null },
    "staff": ["1001"]
  }],
  "poorWeatherPlan": null,
  "schedule": null,
  "semesterCost": null,
  "requirements": [],
  "staff": ["1001"],
  "staffForReports": [],
  "studentLeaders": [],
  "lastCheck": "2026-10-21T12:00:00.000Z",
  "cache": "HIT"
}</code></pre>
    <p><code>description</code> 优先使用英文，缺失时回退中文；<code>descriptionZh</code> 单独保留中文。
      <code>grades.min/max</code> 为数字字符串，幼儿园使用 "-2"、"-1"、"0"。
      <code>meetings</code> 保存所有时段及各时段的教职工 ID；顶层 <code>staff</code> 为其去重并集。
      兼容字段 <code>meeting</code> 保存最后一个时段。</p>
    <p>活动不存在时返回 404：</p>
    <pre><code>{
  "error": "Activity 7095 not found.",
  "lastCheck": "2026-10-21T12:00:00.000Z",
  "source": "api-fetch-empty",
  "cache": "HIT"
}</code></pre>
  </section>
  <section id="staff">
    <h2>教职工</h2>
    <p><a href="/v1/staffs"><code>GET /v1/staffs</code></a>：教职工 ID 到姓名的映射，元数据位于同一层。</p>
    <pre><code>{
  "1001": "Example Teacher",
  "lastCheck": "2026-10-21T12:00:00.000Z",
  "cache": "HIT"
}</code></pre>
  </section>
  <section id="metadata">
    <h2>响应头与缓存</h2>
    <ul>
      <li><code>X-Request-ID</code>：每次请求的标识，用于日志排查。</li>
      <li><code>X-Total-Count</code>：活动列表分页前的匹配数量。</li>
      <li><code>X-Cache</code>：活动详情与教职工的缓存状态。</li>
      <li><code>X-Data-Updated-At</code>：活动详情与教职工数据的实际抓取时间，与 <code>lastCheck</code> 一致。</li>
    </ul>
    <p>以上响应头允许通过 CORS 读取；允许的来源由服务配置决定。</p>
    <ul>
      <li><code>HIT</code>：缓存仍在新鲜期内，也适用于已缓存的活动不存在记录。</li>
      <li><code>MISS</code>：无可用缓存，等待采集；同一资源的并发采集合并。</li>
      <li><code>STALE</code>：立即返回旧数据并后台刷新；刷新失败保留旧数据。</li>
    </ul>
  </section>
  <section id="errors">
    <h2>错误</h2>
    <p>错误响应包含 <code>error</code>，并视情况提供 <code>code</code>、<code>requestId</code> 或其他诊断字段。</p>
    <pre><code>{
  "error": "Invalid Activity ID format.",
  "code": "VALIDATION_ERROR",
  "requestId": "example-request-id"
}</code></pre>
    <ul>
      <li><code>400</code>：输入无效。</li>
      <li><code>403</code>：请求的 Origin 不被允许。</li>
      <li><code>404</code>：活动或端点不存在。</li>
      <li><code>429</code>：请求过多，<code>Retry-After</code> 为建议等待秒数。</li>
      <li><code>500</code>：未预期的内部错误。</li>
      <li><code>503</code>：存储、上游暂不可用或服务正在关闭，<code>Retry-After</code> 为 30 秒。</li>
      <li><code>504</code>：请求超时或取消。</li>
    </ul>
  </section>
  <section id="operations">
    <h2>健康检查与指标</h2>
    <ul>
      <li><a href="/health/live"><code>GET /health/live</code></a>：进程存活，返回 <code>{"status":"ok"}</code>。</li>
      <li><a href="/health/ready"><code>GET /health/ready</code></a>：检查 Redis，正常返回 <code>{"status":"ready"}</code>，不可用或关闭中返回 503；不检查上游登录或数据预热。</li>
      <li><a href="/metrics"><code>GET /metrics</code></a>：Prometheus 文本格式指标。</li>
    </ul>
  </section>
</main>
<script>(${initializeApiExplorer.toString()})();</script>
</body>
</html>`;
