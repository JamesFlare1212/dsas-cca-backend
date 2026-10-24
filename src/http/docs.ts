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
  </style>
</head>
<body>
<header>
  <h1>DSAS CCA API 文档</h1>
  <p>接口前缀：<code>/v1</code>。所有数据接口使用 <code>GET</code>，返回 JSON。
    以下路径均相对于当前服务地址；示例数据仅用于说明结构。</p>
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
</body>
</html>`;
