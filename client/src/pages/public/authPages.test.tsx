// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ROUTER_FUTURE } from '../../routerFuture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { TOKEN_KEY } from '../../lib/tokenStorage';
import { ApiRequestError } from '../../lib/apiClient';
import { services } from '../../services';
import { passwordStrength } from '../../lib/passwordStrength';
import { AppRoutes } from '../../routes';
import { ToastProvider } from '../../components/ui';

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

/** Real AuthProvider + the default `services` (mock adapters) — the same path the demo uses. */
function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[path]} future={ROUTER_FUTURE}>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
          <LocationProbe />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>
    </QueryClientProvider>,
  );
}

const location = () => screen.getByTestId('location').textContent;
const describedText = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' | ');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('landing page', () => {
  it('renders the proposition, both calls to action and the product preview', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: /Turn recorded lectures into something you can search, question and revise/ })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Get started' }).every((a) => a.getAttribute('href') === '/register')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Sign in' }).some((a) => a.getAttribute('href') === '/login')).toBe(true);
    const preview = screen.getByRole('figure');
    expect(preview.textContent).toContain('5:00');
    expect(preview.textContent).toContain('5:57');
    expect(preview.textContent).toContain('6:26');
    expect(screen.getByRole('heading', { level: 2, name: 'How it works' })).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/academic project/)).toBeTruthy();
  });
});

describe('login', () => {
  it('has real labels and shows linked, icon + text field errors on an empty submit', async () => {
    renderAt('/login');
    const email = await screen.findByLabelText(/^Email/);
    const password = screen.getByLabelText(/^Password\*$/);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(email)).toContain('Enter your email address');
    expect(describedText(password)).toContain('Enter your password');
    const errorEl = document.getElementById(email.getAttribute('aria-describedby')!.split(' ').pop()!)!;
    expect(errorEl.querySelector('svg')).not.toBeNull(); // not colour alone
    expect(document.activeElement).toBe(email); // focus moves to the first invalid field
  });

  it('validates email format and password length with zod', async () => {
    renderAt('/login');
    fireEvent.change(await screen.findByLabelText(/^Email/), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText(/^Password\*$/), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address, like name@university.edu')).toBeTruthy();
    expect(screen.getByText('Passwords are at least 8 characters')).toBeTruthy();
    // Errors clear as soon as the field is fixed.
    fireEvent.change(screen.getByLabelText(/^Password\*$/), { target: { value: 'long-enough' } });
    expect(screen.queryByText('Passwords are at least 8 characters')).toBeNull();
  });

  it('wrong credentials: readable form error, announced in the polite toast region, stays on /login', async () => {
    renderAt('/login');
    fireEvent.change(await screen.findByLabelText(/^Email/), { target: { value: 'teacher@lecturelens.dev' } });
    fireEvent.change(screen.getByLabelText(/^Password\*$/), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const formError = await screen.findByText('Invalid email or password', { selector: '#login-form-error p' });
    expect(formError.textContent).toBe('Error: Invalid email or password');
    const region = screen.getByRole('status', { name: 'Status messages' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(within(region).getByText('Sign-in failed')).toBeTruthy();
    expect(location()).toBe('/login');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('demo teacher → /app/dashboard with the teacher sidebar', async () => {
    renderAt('/login');
    const demo = await screen.findByRole('region', { name: 'Demo accounts' });
    fireEvent.click(within(demo).getByRole('button', { name: /Use demo teacher/ }));
    expect((screen.getByLabelText(/^Email/) as HTMLInputElement).value).toBe('teacher@lecturelens.dev');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back, Ananya' })).toBeTruthy();
    expect(location()).toBe('/app/dashboard');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['Dashboard', 'My Lectures', 'Upload', 'Review Queue', 'Students']);
  });

  it('demo student → /app/dashboard with the student sidebar', async () => {
    renderAt('/login');
    fireEvent.click(await screen.findByRole('button', { name: /Use demo student/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Rohan$/ })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['Dashboard', 'Lectures', 'Search', 'Ask', 'Quizzes', 'Revision']);
  });

  it('returns to the page RequireAuth saved', async () => {
    renderAt('/app/review');
    expect(await screen.findByText('Sign in to continue to the page you asked for.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use demo teacher/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Review Queue' })).toBeTruthy();
    expect(location()).toBe('/app/review');
  });

  it('"Remember me" off keeps the token in sessionStorage only', async () => {
    renderAt('/login');
    fireEvent.click(await screen.findByRole('button', { name: /Use demo student/ }));
    fireEvent.click(screen.getByLabelText(/Remember me/));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Rohan$/ });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toMatch(/^mock-token\./);
  });

  it('"Forgot password" is focusable, marked disabled, and explains why on focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/login');
    const forgot = await screen.findByRole('button', { name: 'Forgot password?' });
    expect(forgot.getAttribute('aria-disabled')).toBe('true');
    expect(forgot.hasAttribute('disabled')).toBe(false);
    fireEvent.focus(forgot);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByRole('tooltip').textContent).toBe('Password reset is out of scope for this academic project.');
    vi.useRealTimers();
  });

  it('tab order: email, password, remember, forgot, submit, then demo buttons', async () => {
    renderAt('/login');
    await screen.findByLabelText(/^Email/);
    const main = document.getElementById('main')!;
    const order = Array.from(main.querySelectorAll<HTMLElement>('input, button, a[href]')).map(
      (el) => el.getAttribute('aria-label') ?? ((el as HTMLInputElement).labels?.[0]?.textContent || el.textContent || '').trim(),
    );
    expect(order.slice(0, 7)).toEqual([
      'Email*',
      'Password*',
      'Remember me',
      'Forgot password?',
      'Sign in',
      'Create an account',
      'Use demo teacherteacher@lecturelens.dev',
    ]);
  });
});

describe('register', () => {
  const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('shows the password-match error even while other fields are still invalid', async () => {
    renderAt('/register');
    await screen.findByLabelText(/^Full name/);
    fill(/^Password\*$/, 'correct horse 1');
    fill(/^Confirm password/, 'different');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Enter your name')).toBeTruthy();
    expect(screen.getByText('Passwords don’t match')).toBeTruthy();
    expect(screen.getByLabelText(/^Confirm password/).getAttribute('aria-invalid')).toBe('true');
  });

  it('role is chosen with two radio cards inside a labelled group', async () => {
    renderAt('/register');
    const group = await screen.findByRole('group', { name: /I am a/ });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(group).getByText('Teacher'));
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    expect(group.textContent).toContain('Upload lectures, correct transcripts');
  });

  it('strength meter reports length + variety in text, linked to the password field', async () => {
    renderAt('/register');
    const password = await screen.findByLabelText(/^Password\*$/);
    fill(/^Password\*$/, 'abcdefgh');
    expect(describedText(password)).toContain('Strength: Weak');
    fill(/^Password\*$/, 'Abcdefgh12!x');
    expect(describedText(password)).toContain('Strength: Strong');
    expect(screen.getByRole('progressbar', { name: 'Password strength: Strong' })).toBeTruthy();
  });

  it('creates a teacher account and lands on the teacher dashboard', async () => {
    renderAt('/register');
    fill(/^Full name/, 'Prof. Grace Hopper');
    fill(/^Email/, 'grace.hopper@uni.edu');
    fill(/^Password\*$/, 'Compilers1952!');
    fill(/^Confirm password/, 'Compilers1952!');
    fireEvent.click(screen.getByText('Teacher'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back, Grace' })).toBeTruthy();
    expect(location()).toBe('/app/dashboard');
    expect(screen.getByRole('link', { name: 'Upload' })).toBeTruthy();
  });

  it('a server error is never shown as success: stays on /register with a readable error, no token, no "Account created" (and keeps the form)', async () => {
    vi.spyOn(services.auth, 'register').mockRejectedValue(
      new ApiRequestError({ status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' }),
    );
    renderAt('/register');
    fill(/^Full name/, 'Priya Natarajan');
    fill(/^Email/, 'priya@example.edu');
    fill(/^Password\*$/, 'notebook42');
    fill(/^Confirm password/, 'notebook42');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText(/Something went wrong on our side/, { selector: '#register-form-error p' })).toBeTruthy();
    expect(location()).toBe('/register');
    expect(screen.queryByText('Account created')).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect((screen.getByLabelText(/^Email/) as HTMLInputElement).value).toBe('priya@example.edu');
    vi.restoreAllMocks();
  });

  it('an existing email is reported on the email field and in the form error', async () => {
    renderAt('/register');
    fill(/^Full name/, 'Someone');
    fill(/^Email/, 'student@lecturelens.dev');
    fill(/^Password\*$/, 'password123');
    fill(/^Confirm password/, 'password123');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(screen.getByLabelText(/^Email/).getAttribute('aria-invalid')).toBe('true'));
    expect(describedText(screen.getByLabelText(/^Email/))).toContain('An account with this email already exists');
    expect(screen.getByText(/An account with this email already exists\.$/, { selector: '#register-form-error p' })).toBeTruthy();
  });
});

describe('error pages', () => {
  it.each([
    ['/403', 'You don’t have access to this page'],
    ['/404', 'We couldn’t find that page'],
    ['/no/such/page', 'We couldn’t find that page'],
  ])('%s renders an EmptyState with "Back to dashboard"', async (path, title) => {
    renderAt(path);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to dashboard' })).toBeTruthy();
  });
});

describe('passwordStrength', () => {
  it('scores length and variety only', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: 'Too short' });
    expect(passwordStrength('abc12')).toEqual({ score: 0, label: 'Too short' });
    expect(passwordStrength('abcdefgh')).toEqual({ score: 1, label: 'Weak' });
    expect(passwordStrength('abcdefg1')).toEqual({ score: 2, label: 'Fair' });
    expect(passwordStrength('abcdefghijkl')).toEqual({ score: 2, label: 'Fair' });
    expect(passwordStrength('Abcdefg1')).toEqual({ score: 3, label: 'Good' });
    expect(passwordStrength('Abcdefgh12!x')).toEqual({ score: 4, label: 'Strong' });
  });
});
