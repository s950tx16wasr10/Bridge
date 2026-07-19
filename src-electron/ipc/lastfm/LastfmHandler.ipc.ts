/**
 * Bridge Last.fm Discover Module - IPC Handlers
 */

import { LastfmSyncAction, LastfmSyncProgress, LastfmValidateResult, MatchQuery, MatchResult } from '../../../src-shared/interfaces/lastfm.interface.js'
import { mainWindow } from '../../main.js'
import { getLastfmService } from './LastfmService.js'

// Initialize event forwarding
let initialized = false

function initLastfmService() {
	if (initialized) return
	initialized = true

	const service = getLastfmService()
	service.on('progress', (progress: LastfmSyncProgress) => {
		try {
			mainWindow?.webContents.send('lastfmSyncProgress', progress)
		} catch {
			// Window might be closed
		}
	})
}

/**
 * Validate a Last.fm username + API key pair
 */
export async function lastfmValidateUser(input: { username: string; apiKey: string }): Promise<LastfmValidateResult> {
	const service = getLastfmService()
	return service.validateUser(input.username.trim(), input.apiKey.trim())
}

/**
 * Query the cached match results for the Discover tab
 */
export async function lastfmGetMatches(query: MatchQuery): Promise<MatchResult> {
	const service = getLastfmService()
	return service.getMatches(query)
}

/**
 * The last emitted sync progress, so a reloaded renderer can re-attach to a running sync
 */
export async function lastfmGetSyncState(): Promise<LastfmSyncProgress | null> {
	const service = getLastfmService()
	return service.getSyncState()
}

/**
 * Start or cancel a sync
 */
export function lastfmSync(action: LastfmSyncAction): void {
	initLastfmService()

	const service = getLastfmService()
	if (action.action === 'start') {
		service.startSync(action.options)
	} else {
		service.cancelSync()
	}
}
