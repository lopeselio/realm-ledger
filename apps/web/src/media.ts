// Which kind of screen this is. The phone layout is one media query, kept here only: the page
// gets the class `phone` on <html> while it matches, and style.css styles `html.phone`.

/** A phone or small tablet held by thumb: a narrow screen, or a touch one up to tablet width. */
export const PHONE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-width: 900px)';

function query(): MediaQueryList | null {
  try {
    return window.matchMedia(PHONE_QUERY);
  } catch {
    return null;
  }
}

export const isPhone = (): boolean => query()?.matches ?? false;

/** Keeps <html class="phone"> in step with the query; call once at start-up. */
export function watchPhone(): void {
  const mq = query();
  const set = (): void => void document.documentElement.classList.toggle('phone', mq?.matches ?? false);
  set();
  mq?.addEventListener('change', set);
}
