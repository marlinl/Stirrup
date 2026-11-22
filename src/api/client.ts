export type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>;

/** Create a same-origin JSON client; application lifecycle owns the response to an expired login. */
export function createApi(unauthorized: () => void): Api {
  return async <T>(path: string, method = 'GET', data?: unknown): Promise<T> => {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) unauthorized();
      throw new Error(result.error ?? `请求失败 (${response.status})`);
    }
    return result as T;
  };
}
