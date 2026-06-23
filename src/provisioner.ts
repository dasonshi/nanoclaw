import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const PROFILES_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.ghl',
  'profiles.yaml',
);
const BRIDGE_URL = 'http://localhost:18800';
const TEMPLATE_PATH = path.join(GROUPS_DIR, '_templates', 'customer.md');

export interface ProvisionInput {
  businessName: string;
  locationId: string;
  pitToken: string;
  description: string;
  botName: string;
  chatJid: string;
}

export interface ProvisionResult {
  slug: string;
  groupFolder: string;
  bridgeToken: string;
}

/**
 * Generate a URL-safe slug from a business name.
 * Lowercase, spaces→underscores, strip special chars, truncate to 64.
 */
export function generateSlug(businessName: string): string {
  return businessName
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

/**
 * Provision a new customer:
 * 1. Generate bridge token
 * 2. Append profile to profiles.yaml
 * 3. Reload bridge
 * 4. Generate CLAUDE.md from template
 * 5. Write .bridge-token file
 */
export async function provision(
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const slug = generateSlug(input.businessName);
  if (!slug || slug.length < 2) {
    throw new Error(`Cannot generate valid slug from "${input.businessName}"`);
  }

  const groupFolder = `telegram_${slug}`;
  const groupDir = path.join(GROUPS_DIR, groupFolder);

  // Check for conflicts
  if (fs.existsSync(groupDir)) {
    throw new Error(`Group folder already exists: ${groupFolder}`);
  }

  let profileContent: string;
  try {
    profileContent = fs.readFileSync(PROFILES_PATH, 'utf-8');
  } catch {
    profileContent = '';
  }
  if (profileContent.includes(`  ${slug}:`)) {
    throw new Error(`Profile '${slug}' already exists in profiles.yaml`);
  }

  // Step 1: Generate bridge token
  const bridgeToken = crypto.randomBytes(24).toString('hex');

  // Step 2: Append profile to profiles.yaml
  const profileBlock = `\n  ${slug}:\n    location_id: "${input.locationId}"\n    access_token: "${input.pitToken}"\n    bridge_token: "${bridgeToken}"\n`;
  fs.appendFileSync(PROFILES_PATH, profileBlock);
  logger.info({ slug }, 'Added profile to profiles.yaml');

  // Step 3: Reload bridge
  await reloadBridge(slug);

  // Step 4: Generate CLAUDE.md from template
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  let template: string;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const claudeMd = template
    .replace(/\{\{BUSINESS_NAME\}\}/g, input.businessName)
    .replace(/\{\{LOCATION_ID\}\}/g, input.locationId)
    .replace(/\{\{BUSINESS_DESCRIPTION\}\}/g, input.description)
    .replace(/\{\{BOT_NAME\}\}/g, input.botName);

  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);

  // Step 5: Write .bridge-token file (chmod 600)
  const tokenPath = path.join(groupDir, '.bridge-token');
  fs.writeFileSync(tokenPath, bridgeToken);
  fs.chmodSync(tokenPath, 0o600);

  logger.info({ slug, groupFolder }, 'Provisioning complete');

  return { slug, groupFolder, bridgeToken };
}

/**
 * Add a new location for an existing customer.
 * Creates bridge profile but does NOT create a new group folder.
 */
export interface AddLocationInput {
  slug: string;
  locationId: string;
  pitToken: string;
  description: string;
  botName: string;
}

export interface AddLocationResult {
  bridgeToken: string;
  profileSlug: string;
}

export async function provisionLocation(
  input: AddLocationInput,
): Promise<AddLocationResult> {
  // Use a profile slug that combines customer slug + location ID to avoid collisions
  const profileSlug = `${input.slug}_${input.locationId}`;

  let profileContent: string;
  try {
    profileContent = fs.readFileSync(PROFILES_PATH, 'utf-8');
  } catch {
    profileContent = '';
  }
  if (profileContent.includes(`  ${profileSlug}:`)) {
    throw new Error(`Profile '${profileSlug}' already exists in profiles.yaml`);
  }

  const bridgeToken = crypto.randomBytes(24).toString('hex');

  const profileBlock = `\n  ${profileSlug}:\n    location_id: "${input.locationId}"\n    access_token: "${input.pitToken}"\n    bridge_token: "${bridgeToken}"\n`;
  fs.appendFileSync(PROFILES_PATH, profileBlock);
  logger.info({ profileSlug }, 'Added location profile to profiles.yaml');

  await reloadBridge(profileSlug);

  return { bridgeToken, profileSlug };
}

/**
 * Switch the active location for a customer.
 * Updates .bridge-token and regenerates CLAUDE.md.
 */
export function switchActiveLocation(
  groupFolder: string,
  bridgeToken: string,
  businessName: string,
  locationId: string,
  description: string,
  botName: string,
): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);

  // Update .bridge-token
  const tokenPath = path.join(groupDir, '.bridge-token');
  fs.writeFileSync(tokenPath, bridgeToken);
  fs.chmodSync(tokenPath, 0o600);

  // Regenerate CLAUDE.md
  let template: string;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const claudeMd = template
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName)
    .replace(/\{\{LOCATION_ID\}\}/g, locationId)
    .replace(/\{\{BUSINESS_DESCRIPTION\}\}/g, description)
    .replace(/\{\{BOT_NAME\}\}/g, botName);

  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), claudeMd);

  logger.info({ groupFolder, locationId }, 'Switched active location');
}

/**
 * Remove a location's profile from profiles.yaml and reload bridge.
 */
export async function deprovisionLocation(profileSlug: string): Promise<void> {
  try {
    const content = fs.readFileSync(PROFILES_PATH, 'utf-8');
    // Remove the profile block (from "  slug:" to next profile or end)
    const pattern = new RegExp(
      `\\n  ${escapeRegex(profileSlug)}:\\n(?:    [^\\n]+\\n)*`,
    );
    const updated = content.replace(pattern, '');
    fs.writeFileSync(PROFILES_PATH, updated);
    logger.info({ profileSlug }, 'Removed profile from profiles.yaml');
  } catch (err) {
    logger.warn(
      { profileSlug, err },
      'Failed to remove profile from profiles.yaml',
    );
  }

  await reloadBridge(profileSlug);
}

/**
 * Update PIT token for an existing profile in profiles.yaml.
 */
export async function updateProfileToken(
  profileSlug: string,
  newPitToken: string,
): Promise<string> {
  const newBridgeToken = crypto.randomBytes(24).toString('hex');

  try {
    let content = fs.readFileSync(PROFILES_PATH, 'utf-8');
    // Replace the access_token and bridge_token lines for this profile
    const pattern = new RegExp(
      `(  ${escapeRegex(profileSlug)}:\\n    location_id: "[^"]*"\\n)    access_token: "[^"]*"\\n    bridge_token: "[^"]*"`,
    );
    content = content.replace(
      pattern,
      `$1    access_token: "${newPitToken}"\n    bridge_token: "${newBridgeToken}"`,
    );
    fs.writeFileSync(PROFILES_PATH, content);
    logger.info({ profileSlug }, 'Updated profile token');
  } catch (err) {
    throw new Error(`Failed to update profile token: ${err}`);
  }

  await reloadBridge(profileSlug);
  return newBridgeToken;
}

async function reloadBridge(context: string): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_URL}/admin/reload`, { method: 'POST' });
    if (res.ok) {
      logger.info({ context }, 'Bridge reloaded');
    } else {
      logger.warn({ context }, 'Bridge reload returned non-OK status');
    }
  } catch {
    logger.warn({ context }, 'Bridge not reachable — reload manually');
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
