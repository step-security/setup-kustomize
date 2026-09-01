import {GitHub, getOctokitOptions} from '@actions/github/lib/utils'
import {OctokitOptions} from '@octokit/core/dist-types/types.d'
import {throttling} from '@octokit/plugin-throttling'
import * as core from '@actions/core'
import * as cache from '@actions/tool-cache'
import * as crypto from 'crypto'
import * as path from 'path'
import * as semver from 'semver'
import * as fs from 'fs'
let tempDirectory = process.env['RUNNER_TEMPDIRECTORY'] || ''

const EnhancedOctokit = GitHub.plugin(throttling)

const githubToken = core.getInput('github-token')
const failFast = core.getBooleanInput('fail-fast')

let options: OctokitOptions = {
  throttle: {
    onRateLimit: (retryAfter: Number, opts: OctokitOptions) => {
      core.warning(
        `Request quota exhausted for request ${opts.method} ${opts.url}`
      )
      if (!failFast) {
        core.warning(`Retrying after ${retryAfter} seconds!`)
      }
      return !failFast
    },
    onSecondaryRateLimit: (retryAfter: Number, opts: OctokitOptions) => {
      core.warning(`Abuse detected for request ${opts.method} ${opts.url}`)
      if (!failFast) {
        core.warning(`Retrying after ${retryAfter} seconds!`)
      }
      return !failFast
    }
  }
}

if (process.env.NODE_ENV === 'test') {
  options = githubToken ? getOctokitOptions(githubToken, options) : options
} else {
  options = getOctokitOptions(githubToken, options)
}

const octokit = new EnhancedOctokit(options)
const versionRegex = /\d+\.?\d*\.?\d*/
const toolName = 'kustomize'
const platform = process.platform
const arch = process.arch === 'x64' ? 'amd64' : process.arch

if (!tempDirectory) {
  let baseLocation
  if (process.platform === 'win32') {
    // On windows use the USERPROFILE env variable
    baseLocation = process.env['USERPROFILE'] || 'C:\\'
  } else {
    if (process.platform === 'darwin') {
      baseLocation = '/Users'
    } else {
      baseLocation = '/home'
    }
  }
  tempDirectory = path.join(baseLocation, 'actions', 'temp')
}

export async function getKustomize(targetVersion: string): Promise<void> {
  if (!semver.validRange(targetVersion))
    throw new Error(`invalid semver requested: ${targetVersion}`)

  const resolver = semver.valid(targetVersion)
    ? getPinnedVersion
    : getMaxSatisfyingVersion

  let kustomizePath = cache.find('kustomize', targetVersion)

  if (!kustomizePath) {
    const version = await resolver(targetVersion)
    kustomizePath = await acquireVersion(version)
  }

  return core.addPath(kustomizePath)
}

interface Version {
  resolved: string
  target: string
  url: string
  checksumUrl: string | undefined
}

async function getPinnedVersion(targetVersion: string): Promise<Version> {
  const prefix = semver.gt(targetVersion, '3.2.0') ? 'kustomize/v' : 'v'

  try {
    const response = await octokit.rest.repos.getReleaseByTag({
      owner: 'kubernetes-sigs',
      repo: 'kustomize',
      tag: prefix + targetVersion
    })

    if (response.status !== 200) {
      throw new Error(`Invalid response status ${response.status}`)
    }

    const release = response.data

    const matchingAsset = release.assets.find(
      asset =>
        asset.name.includes('kustomize') &&
        asset.name.includes(platform) &&
        asset.name.includes(arch)
    )

    if (matchingAsset) {
      const kustomizeVersion = (
        versionRegex.exec(release.tag_name) || []
      ).shift()

      if (kustomizeVersion != null) {
        const checksumAsset = release.assets.find(
          asset => asset.name === 'checksums.txt'
        )
        return {
          target: targetVersion,
          resolved: kustomizeVersion,
          url: matchingAsset.browser_download_url,
          checksumUrl: checksumAsset?.browser_download_url
        }
      } else {
        throw new Error(
          `Could not find version in release tag ${release.tag_name}`
        )
      }
    } else {
      throw new Error(
        `Could not find asset for platform '${platform}' and '${arch}'.`
      )
    }
  } catch (err) {
    throw new Error(`Could not satisfy version range ${targetVersion}: ${err}`)
  }
}

async function getMaxSatisfyingVersion(
  targetVersion: string
): Promise<Version> {
  const version = {target: targetVersion}
  const availableVersions: Map<
    string,
    {url: string; checksumUrl: string | undefined}
  > = new Map()

  for await (const response of octokit.paginate.iterator(
    octokit.rest.repos.listReleases,
    {
      owner: 'kubernetes-sigs',
      repo: 'kustomize',
      per_page: 100
    }
  )) {
    for (const release of response.data) {
      const matchingAsset = release.assets.find(
        asset =>
          asset.name.includes('kustomize') &&
          asset.name.includes(platform) &&
          asset.name.includes(arch)
      )

      if (matchingAsset) {
        const kustomizeVersion = (
          versionRegex.exec(release.tag_name) || []
        ).shift()

        if (kustomizeVersion != null) {
          const checksumAsset = release.assets.find(
            asset => asset.name === 'checksums.txt'
          )
          availableVersions.set(kustomizeVersion, {
            url: matchingAsset.browser_download_url,
            checksumUrl: checksumAsset?.browser_download_url
          })
        }
      }
    }
  }

  const resolved = semver.maxSatisfying(
    [...availableVersions.keys()],
    version.target
  )

  if (!resolved) {
    throw new Error(
      `Could not satisfy version '${version.target}': Could not find asset for platform '${platform}' and
      ${arch}'.`
    )
  }

  const {url, checksumUrl} = availableVersions.get(resolved) as {
    url: string
    checksumUrl: string | undefined
  }

  return {...version, resolved, url, checksumUrl}
}

async function acquireVersion(version: Version): Promise<string> {
  const toolFilename =
    process.platform === 'win32' ? `${toolName}.exe` : toolName
  let toolPath: string

  try {
    toolPath = await cache.downloadTool(version.url)
  } catch (err) {
    throw new Error(`Failed to download version ${version.target}: ${err}`)
  }

  if (version.checksumUrl) {
    await verifyChecksum(
      toolPath,
      path.basename(version.url),
      version.checksumUrl
    )
  }

  if (version.url.endsWith('.tar.gz')) {
    toolPath = await cache.extractTar(toolPath)
    toolPath = path.join(toolPath, toolFilename)
  }

  switch (process.platform) {
    case 'linux':
    case 'darwin':
      fs.chmodSync(toolPath, 0o755)
      break
  }

  return await cache.cacheFile(toolPath, toolFilename, toolName, version.target)
}

async function verifyChecksum(
  filePath: string,
  filename: string,
  checksumUrl: string
): Promise<void> {
  let checksumPath: string
  try {
    checksumPath = await cache.downloadTool(checksumUrl)
  } catch (err) {
    throw new Error(`Failed to download checksums: ${err}`)
  }

  const content = fs.readFileSync(checksumPath, 'utf-8')
  const expectedHash = parseChecksums(content).get(filename)

  if (!expectedHash) {
    throw new Error(`No checksum found for ${filename}`)
  }

  const actualHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${filename}: expected ${expectedHash}, got ${actualHash}`
    )
  }

  core.debug(`Checksum verified for ${filename}`)
}

function parseChecksums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.trim().split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2) {
      map.set(parts[1], parts[0])
    }
  }
  return map
}
