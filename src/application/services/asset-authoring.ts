import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic } from '../../domain/validation'
import {
	decodeStrictBase64,
	validateAssetContentMetadata,
	validateAssetMetadata,
	type AuthoredAsset,
	type AuthoredAssetResource,
} from '../../domain/assets/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateAssetCommand = Readonly<{
	id?: string
	name: string
	contentFilename: string
	mediaType: string
	contentBase64: string
}>

export type ReplaceAssetCommand = Readonly<{
	assetId: string
	expectedRevision: string
	name: string
	contentFilename: string
	mediaType: string
	contentBase64: string
}>

export type AssetAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type AssetAuthoringService = Readonly<{
	createAsset(command: CreateAssetCommand): Promise<AssetAuthoringResult>
	replaceAsset(command: ReplaceAssetCommand): Promise<AssetAuthoringResult>
}>

export function createAssetAuthoringService(persistence: FileNativePersistence): AssetAuthoringService {
	const decodeBase64Content = decodeStrictBase64

	async function createAsset(command: CreateAssetCommand): Promise<AssetAuthoringResult> {
		const id = command.id ?? randomUUID()
		if (!isFullUuid(id))
			return {
				status: 'invalid',
				key: id,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/id', message: 'Asset id must be a full UUID.' }],
			}

		const decoded = decodeBase64Content(command.contentBase64, '/contentBase64')
		if (!decoded.ok)
			return { status: 'invalid', key: id, diagnostics: decoded.diagnostics }

		const metadata: AuthoredAsset = {
			id,
			name: command.name,
			contentFilename: command.contentFilename,
			mediaType: command.mediaType,
		}

		const metadataValidation = validateAssetMetadata(metadata, id)
		const contentValidation = metadataValidation.ok
			? validateAssetContentMetadata(metadata, command.contentFilename, decoded.bytes)
			: { ok: true, diagnostics: [] }

		const diagnostics = [...metadataValidation.diagnostics, ...contentValidation.diagnostics]
		if (diagnostics.length > 0)
			return { status: 'invalid', key: id, diagnostics }

		const resource: AuthoredAssetResource = {
			metadata,
			content: decoded.bytes,
		}

		try {
			const revision = await persistence.assets.create(id, resource)
			const inspected = await persistence.assets.readInspected(id)
			return { status: 'created', key: id, revision, diagnostics: inspected?.diagnostics ?? [] }
		}
		catch (error) {
			if (!(error instanceof PersistenceError) || (error.code !== 'persistence.resource_exists' && error.code !== 'persistence.asset_shape_invalid')) throw error
			const currentRevision = await persistence.assets.readRevision(id)
			return { status: 'already_exists', key: id, ...(currentRevision ? { currentRevision } : {}) }
		}
	}

	async function replaceAsset(command: ReplaceAssetCommand): Promise<AssetAuthoringResult> {
		if (!isFullUuid(command.assetId))
			return {
				status: 'invalid',
				key: command.assetId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/assetId', message: 'Asset id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.assetId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.assets.read(command.assetId)
		if (!current) return { status: 'not_found', key: command.assetId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.assetId, currentRevision: current.revision }

		const decoded = decodeBase64Content(command.contentBase64, '/contentBase64')
		if (!decoded.ok)
			return { status: 'invalid', key: command.assetId, diagnostics: decoded.diagnostics }

		const metadata: AuthoredAsset = {
			id: command.assetId,
			name: command.name,
			contentFilename: command.contentFilename,
			mediaType: command.mediaType,
		}

		const metadataValidation = validateAssetMetadata(metadata, command.assetId)
		const contentValidation = metadataValidation.ok
			? validateAssetContentMetadata(metadata, command.contentFilename, decoded.bytes)
			: { ok: true, diagnostics: [] }

		const diagnostics = [...metadataValidation.diagnostics, ...contentValidation.diagnostics]
		if (diagnostics.length > 0)
			return { status: 'invalid', key: command.assetId, diagnostics }

		const next: AuthoredAssetResource = {
			metadata,
			content: decoded.bytes,
		}

		const commit = await persistence.assets.compareAndSwap({
			key: command.assetId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.assetId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.assets.readInspected(command.assetId)
		return { status: 'updated', key: command.assetId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	return { createAsset, replaceAsset }
}
