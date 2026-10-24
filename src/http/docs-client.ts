// Serialized into the documentation page; keep all browser dependencies inside this function.
export function initializeApiExplorer() {
  function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing API explorer element: ${id}`);
    return node as T;
  }

  const form = element<HTMLFormElement>('api-explorer');
  const endpoint = element<HTMLSelectElement>('request-endpoint');
  const fields = element<HTMLFieldSetElement>('request-fields');
  const filters = element<HTMLFieldSetElement>('list-filters');
  const detail = element<HTMLFieldSetElement>('detail-parameters');
  const activityId = element<HTMLInputElement>('request-activity-id');
  const send = element<HTMLButtonElement>('request-send');
  const cancel = element<HTMLButtonElement>('request-cancel');
  const reset = element<HTMLButtonElement>('request-reset');
  const requestUrl = element<HTMLElement>('request-url');
  const curl = element<HTMLElement>('request-curl');
  const status = element<HTMLElement>('response-status');
  const responseUrl = element<HTMLElement>('response-url');
  const headers = element<HTMLElement>('response-headers');
  const body = element<HTMLElement>('response-body');
  const copyStatus = element<HTMLElement>('copy-status');
  let controller: AbortController | undefined;

  function buildUrl() {
    const path = endpoint.value.replace(
      ':activityId',
      encodeURIComponent(activityId.value) || ':activityId',
    );
    const url = new URL(path, window.location.origin);
    if (endpoint.value === '/v1/activity/list') {
      for (const [name, value] of new FormData(form)) {
        if (typeof value === 'string' && value !== '') url.searchParams.set(name, value);
      }
    }
    return url;
  }

  function updateRequest() {
    filters.hidden = filters.disabled = endpoint.value !== '/v1/activity/list';
    element<HTMLElement>('filter-hint').hidden = filters.hidden;
    detail.hidden = detail.disabled = endpoint.value !== '/v1/activity/:activityId';
    const url = buildUrl();
    requestUrl.textContent = url.href;
    // A single quote can occur in URL paths. Escape it before quoting for a POSIX shell.
    curl.textContent = `curl --request GET --url '${url.href.replaceAll("'", "'\\''")}'`;
    copyStatus.textContent = '';
  }

  form.addEventListener('input', updateRequest);
  form.addEventListener('change', updateRequest);
  // The reset event fires before native controls receive their default values.
  form.addEventListener('reset', () => window.setTimeout(updateRequest, 0));
  cancel.addEventListener('click', () => controller?.abort());
  element<HTMLButtonElement>('copy-curl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(curl.textContent ?? '');
      copyStatus.textContent = '已复制 cURL。';
    } catch {
      copyStatus.textContent = '无法访问剪贴板，请手动复制下方 cURL。';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (controller || !form.reportValidity()) return;
    const url = buildUrl();
    const activeController = new AbortController();
    controller = activeController;
    const started = performance.now();
    let timedOut = false;
    // Allow the API's maximum 180-second timeout to finish before the browser times out.
    const timeout = window.setTimeout(() => {
      timedOut = true;
      activeController.abort();
    }, 185000);
    responseUrl.textContent = `GET ${url.href}`;
    status.textContent = '正在发送请求…';
    status.dataset.state = 'pending';
    headers.textContent = '';
    body.textContent = '';
    fields.disabled = send.disabled = reset.disabled = true;
    cancel.disabled = false;
    form.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: activeController.signal,
      });
      headers.textContent = [...response.headers]
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
      const text = await response.text();
      let formatted = text;
      if (response.headers.get('Content-Type')?.includes('application/json')) {
        try {
          formatted = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Keep malformed or non-JSON responses readable instead of hiding the response.
        }
      }
      body.textContent = formatted || '（空响应体）';
      status.textContent = `${response.status} ${response.statusText} · ${Math.round(performance.now() - started)} ms`;
      status.dataset.state = response.ok ? 'success' : 'error';
    } catch (error) {
      const message = activeController.signal.aborted
        ? timedOut
          ? '请求超时，请重试。'
          : '请求已取消。'
        : `网络请求失败：${error instanceof Error ? error.message : String(error)}`;
      status.textContent = `${message} · ${Math.round(performance.now() - started)} ms`;
      status.dataset.state = 'error';
      body.textContent = '未收到完整响应。';
    } finally {
      window.clearTimeout(timeout);
      controller = undefined;
      fields.disabled = send.disabled = reset.disabled = false;
      cancel.disabled = true;
      form.setAttribute('aria-busy', 'false');
    }
  });

  updateRequest();
  fields.disabled = send.disabled = reset.disabled = false;
}
