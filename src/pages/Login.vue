<script setup lang="ts">
/**
 * /login — email auth live (sign in / sign up / reset); GitHub OAuth button
 * rendered only when VITE_GITHUB_AUTH_ENABLED=true (the OAuth app callback
 * targets prod GoTrue — see .env.example).
 */
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '../components/ui/AppButton.vue';
import AppInput from '../components/ui/AppInput.vue';
import AlertBanner from '../components/AlertBanner.vue';
import {
  githubEnabled,
  sendPasswordReset,
  signInWithEmail,
  signInWithGitHub,
  signUpWithEmail,
} from '../lib/auth';

type Mode = 'signin' | 'signup' | 'reset';

const route = useRoute();
const router = useRouter();

const mode = ref<Mode>('signin');
const email = ref('');
const password = ref('');
const name = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

function switchMode(m: Mode) {
  mode.value = m;
  error.value = '';
  notice.value = '';
}

async function submit() {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    if (mode.value === 'signin') {
      await signInWithEmail(email.value.trim(), password.value);
      const dest = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
      router.push(dest);
    } else if (mode.value === 'signup') {
      const { needsConfirmation } = await signUpWithEmail(
        email.value.trim(),
        password.value,
        name.value.trim(),
      );
      if (needsConfirmation) {
        notice.value = 'Account created — check your email to confirm, then sign in.';
        mode.value = 'signin';
      } else {
        router.push('/');
      }
    } else {
      await sendPasswordReset(email.value.trim());
      notice.value = 'Password reset email sent (if the address exists).';
      mode.value = 'signin';
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function github() {
  error.value = '';
  try {
    await signInWithGitHub();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <div class="login">
    <div class="login__panel">
      <div class="login__brand">
        <span class="login__wordmark">ARROW</span>
        <span class="login__divider" aria-hidden="true" />
        <span class="login__label">Flight Tracking</span>
      </div>

      <h1 class="login__title">
        {{ mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password' }}
      </h1>

      <AlertBanner v-if="error" kind="error" :message="error" data-test="auth-error" />
      <AlertBanner v-if="notice" kind="success" :message="notice" />

      <form class="login__form" @submit.prevent="submit">
        <AppInput
          v-if="mode === 'signup'"
          v-model="name"
          label="Name"
          placeholder="Your name"
          required
        />
        <AppInput
          v-model="email"
          label="Email"
          type="email"
          placeholder="you@arrowair.com"
          required
          data-test="email"
        />
        <AppInput
          v-if="mode !== 'reset'"
          v-model="password"
          label="Password"
          type="password"
          placeholder="••••••••••"
          required
          data-test="password"
        />
        <AppButton type="submit" block :disabled="busy" data-test="submit">
          {{ busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Sign up' : 'Send reset email' }}
        </AppButton>
      </form>

      <template v-if="githubEnabled && mode !== 'reset'">
        <div class="login__or"><span>or</span></div>
        <AppButton variant="secondary" block data-test="github" @click="github">
          <template #icon>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
          </template>
          Continue with GitHub
        </AppButton>
      </template>

      <div class="login__links">
        <template v-if="mode === 'signin'">
          <a href="#" @click.prevent="switchMode('signup')">Create account</a>
          <a href="#" @click.prevent="switchMode('reset')">Forgot password?</a>
        </template>
        <a v-else href="#" @click.prevent="switchMode('signin')">Back to sign in</a>
      </div>

      <p class="login__note">
        New accounts start as <strong>operator</strong> with no aircraft
        assignments — an admin grants roles and aircraft access.
      </p>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 1.5rem 3rem;
  background: var(--docs-bg-subtle, #f7f8fa);
}

.login__panel {
  width: 100%;
  max-width: 400px;
  background: var(--docs-bg, #ffffff);
  border: 1px solid var(--card-border, #b1c0ec);
  box-shadow: var(--shadow-hard-strong, 4px 4px 0 0 rgba(0, 0, 0, 0.12));
  padding: 2rem;
}

.login__brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.login__wordmark {
  font-family: var(--font-mono-display, var(--font-mono));
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--brand-dark, #060528);
}

.login__divider {
  width: 1px;
  height: 18px;
  background: var(--docs-border, #d0d9f3);
}

.login__label {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--docs-text-muted, #6b7280);
}

.login__title {
  margin: 0 0 1.25rem;
  font-size: 1.35rem;
}

.login__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login__or {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0;
  color: var(--docs-text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.login__or::before,
.login__or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--docs-border-muted, #e5e7eb);
}

.login__links {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1.25rem;
  font-size: 13px;
}

.login__note {
  margin: 1.25rem 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--docs-text-muted);
}
</style>
