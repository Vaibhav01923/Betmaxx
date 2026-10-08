import { handle } from '../../../lib/handlers.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // chain scans call public blockchain APIs

export const GET = (req) => handle(req);
export const POST = (req) => handle(req);
