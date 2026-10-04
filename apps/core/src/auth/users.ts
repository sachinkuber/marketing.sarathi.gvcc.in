import { AppError } from '../errors.ts'
import type { Auth } from './options.ts'

// Sign-up is switched off for everyone, so a user is made through the library's internal adapter.
// The caller checks the password against the policy before calling this.
export async function createUserWithPassword(
  auth: Auth,
  input: { email: string; name: string; password: string },
): Promise<{ id: string }> {
  const context = await auth.$context
  const email = input.email.trim().toLowerCase()
  if (await context.internalAdapter.findUserByEmail(email)) {
    throw new AppError(409, 'account_exists', 'An account already exists for this email address.')
  }
  const hash = await context.password.hash(input.password)
  let user: { id: string }
  try {
    user = await context.internalAdapter.createUser(
      { email, name: input.name, emailVerified: true },
      // The second argument is required by the types; it is only read if a validateUserInfo hook is set.
      { method: 'admin' },
    )
  } catch (error) {
    // Two requests can pass the check above together; the database's unique email key stops the second.
    if (await context.internalAdapter.findUserByEmail(email)) {
      throw new AppError(409, 'account_exists', 'An account already exists for this email address.')
    }
    throw error
  }
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    // The library does not fill this in, and its own sign-in looks credential accounts up by this exact value.
    issuer: 'local:credential',
    accountId: user.id,
    password: hash,
  })
  return { id: user.id }
}

export async function deleteUser(auth: Auth, userId: string): Promise<void> {
  const context = await auth.$context
  await context.internalAdapter.deleteUser(userId)
}
