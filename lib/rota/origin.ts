/** The app's own address for links it sends: APP_ORIGIN when the platform sets it, else this request's. */
export const appOrigin = (request: Request) =>
  (process.env.APP_ORIGIN ?? new URL(request.url).origin).replace(/\/$/u, "");
