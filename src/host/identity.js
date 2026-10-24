/** Node identity: Ed25519 keypair, stable node id, and request signatures. */
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const privateDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  const publicB64 = publicDer.toString('base64')
  return {
    publicKey: publicB64,
    privateKey: privateDer.toString('base64'),
    id: nodeIdFromPublicKey(publicB64),
  }
}

export function nodeIdFromPublicKey(publicKey) {
  const digest = createHash('sha256').update(String(publicKey)).digest()
  return `n_${digest.toString('base64url').slice(0, 16)}`
}

export function signText(privateKeyB64, text) {
  return sign(null, Buffer.from(String(text), 'utf8'), {
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  }).toString('base64')
}

export function verifyText(publicKeyB64, text, signatureB64) {
  try {
    return verify(null, Buffer.from(String(text), 'utf8'), {
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    }, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
}

export function publicKeyFingerprint(publicKeyB64) {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 6).toUpperCase()
}

export function ensureIdentity(settings) {
  if (settings.node?.publicKey && settings.node?.privateKey && settings.node?.id) {
    return settings.node
  }
  const identity = generateIdentity()
  return { ...settings.node, ...identity }
}