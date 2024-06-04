import Operator from '@dot-i/k8s-operator'
import * as k8s from '@kubernetes/client-node'
import stream from 'stream'

import {
  CreateHookOption,
  CreateOrgOption,
  CreateRepoOption,
  CreateTeamOption,
  EditRepoOption,
  OrganizationApi,
  Repository,
  RepositoryApi,
  Team,
} from '@redkubes/gitea-client-node'
import { orgName, otomiValuesRepoName, teamNameViewer, username } from '../tasks/common'
import { doApiCall, waitTillAvailable } from '../utils'
import { GITEA_PASSWORD, GITEA_URL, OTOMI_VALUES, cleanEnv } from '../validators'

const env = cleanEnv({
  GITEA_PASSWORD,
  GITEA_URL,
  OTOMI_VALUES,
})
console.log('env', env)

// small interface to store hook information
interface hookInfo {
  id?: number
  hasHook: boolean
}

const teamConfig = env.OTOMI_VALUES.teamConfig ?? {}
const teamIds = Object.keys(teamConfig)
const isMultitenant = !!env.OTOMI_VALUES.otomi?.isMultitenant
const hasArgo = !!env.OTOMI_VALUES.apps?.argocd?.enabled

const errors: string[] = []

const readOnlyTeam: CreateTeamOption = {
  ...new CreateTeamOption(),
  canCreateOrgRepo: false,
  name: teamNameViewer,
  includesAllRepositories: false,
  permission: CreateTeamOption.PermissionEnum.Read,
  units: ['repo.code'],
}

const editorTeam: CreateTeamOption = {
  ...readOnlyTeam,
  includesAllRepositories: false,
  permission: CreateTeamOption.PermissionEnum.Write,
}

const adminTeam: CreateTeamOption = { ...editorTeam, permission: CreateTeamOption.PermissionEnum.Admin }
interface groupMapping {
  [key: string]: {
    otomi: string[]
  }
}

const kc = new k8s.KubeConfig()
// loadFromCluster when deploying on cluster
// loadFromDefault when locally connecting to cluster
kc.loadFromDefault()
const k8sApi = kc.makeApiClient(k8s.CoreV1Api)

// SETUP GITEA =====================================================================================

async function upsertTeam(
  existingTeams: Team[] = [],
  orgApi: OrganizationApi,
  teamOption: CreateTeamOption,
): Promise<void> {
  const existingTeam = existingTeams.find((el) => el.name === teamOption.name)
  if (existingTeam)
    return doApiCall(
      errors,
      `Updating team "${teamOption.name}" in org "${orgName}"`,
      () => orgApi.orgEditTeam(existingTeam.id!, teamOption),
      422,
    )
  return doApiCall(
    errors,
    `Updating team "${teamOption.name}" in org "${orgName}"`,
    () => orgApi.orgCreateTeam(orgName, teamOption),
    422,
  )
}

async function upsertRepo(
  existingTeams: Team[] = [],
  existingRepos: Repository[] = [],
  orgApi: OrganizationApi,
  repoApi: RepositoryApi,
  repoOption: CreateRepoOption | EditRepoOption,
  teamName?: string,
): Promise<void> {
  const existingRepo = existingRepos.find((el) => el.name === repoOption.name)
  if (!existingRepo) {
    // org repo create
    await doApiCall(
      errors,
      `Creating repo "${repoOption.name}" in org "${orgName}"`,
      () => orgApi.createOrgRepo(orgName, repoOption as CreateRepoOption),
      422,
    )
  } else {
    // repo update
    await doApiCall(
      errors,
      `Updating repo "${repoOption.name}" in org "${orgName}"`,
      () => repoApi.repoEdit(orgName, repoOption.name!, repoOption as EditRepoOption),
      422,
    )
  }
  // new team repo, add team
  if (teamName)
    await doApiCall(
      errors,
      `Adding repo "${repoOption.name}" to team "${teamName}"`,
      () => repoApi.repoAddTeam(orgName, repoOption.name!, teamName),
      422,
    )
  return undefined
}

async function hasSpecificHook(repoApi: RepositoryApi, hookToFind: string): Promise<hookInfo> {
  const hooks: any[] = await doApiCall(
    errors,
    `Getting hooks in repo "otomi/values"`,
    () => repoApi.repoListHooks(orgName, 'values'),
    400,
  )
  if (!hooks) {
    console.debug(`No hooks were found in repo "values"`)
    return { hasHook: false }
  }

  const foundHook = hooks.find((hook) => {
    return hook.config && hook.config.url.includes(hookToFind)
  })
  if (foundHook) {
    console.debug(`Hook (${hookToFind}) exists in repo "values"`)
    return { id: foundHook.id, hasHook: true }
  }
  console.debug(`Hook (${hookToFind}) not found in repo "values"`)
  return { hasHook: false }
}

async function addTektonHook(repoApi: RepositoryApi): Promise<void> {
  console.debug('Check for Tekton hook')
  const clusterIP = 'http://el-otomi-tekton-listener.otomi-pipelines.svc.cluster.local:8080'
  // k8s.kc()
  // const k8sApi = k8s.core()
  // try {
  //   const response = await k8sApi.readNamespacedService('event-listener', 'team-admin')
  //   const service = response.body
  //   if (service && service.spec && service.spec.clusterIP) {
  //     clusterIP = service.spec.clusterIP
  //     console.log(`Service clusterIP: ${clusterIP}`)
  //   } else {
  //     console.error(`Service "event-listener" in namespace "team-admin" doesn't have a clusterIP.`)
  //   }
  // } catch (error) {
  //   // eslint-disable-next-line no-undef
  //   console.debug(`Error fetching tekton service: ${error}`)
  // }
  const hasTektonHook = await hasSpecificHook(repoApi, 'el-otomi-tekton-listener')
  if (!hasTektonHook.hasHook) {
    console.debug('Tekton Hook needs to be created')
    await doApiCall(
      errors,
      `Adding hook "tekton" to repo otomi/values`,
      () =>
        repoApi.repoCreateHook(orgName, 'values', {
          type: CreateHookOption.TypeEnum.Gitea,
          active: true,
          config: {
            url: clusterIP,
            http_method: 'post',
            content_type: 'json',
          },
          events: ['push'],
        } as CreateHookOption),
      304,
    )
  }
}

async function deleteDroneHook(repoApi: RepositoryApi): Promise<void> {
  console.debug('Check for Drone hook')
  const hasDroneHook = await hasSpecificHook(repoApi, 'drone')
  if (hasDroneHook.hasHook) {
    console.debug('Drone Hook needs to be deleted')
    await doApiCall(errors, `Deleting hook "drone" from repo otomi/values`, () =>
      repoApi.repoDeleteHook(orgName, 'values', hasDroneHook.id!),
    )
  }
}

async function setupGitea() {
  await waitTillAvailable(env.GITEA_URL)

  let giteaUrl = env.GITEA_URL
  if (giteaUrl.endsWith('/')) {
    giteaUrl = giteaUrl.slice(0, -1)
  }

  // create the org
  const orgApi = new OrganizationApi(username, env.GITEA_PASSWORD, `${giteaUrl}/api/v1`)
  const repoApi = new RepositoryApi(username, env.GITEA_PASSWORD, `${giteaUrl}/api/v1`)
  const orgOption = { ...new CreateOrgOption(), username: orgName, repoAdminChangeTeamAccess: true }
  await doApiCall(errors, `Creating org "${orgName}"`, () => orgApi.orgCreate(orgOption), 422)

  const existingTeams = await doApiCall(errors, `Getting all teams in org "${orgName}"`, () =>
    orgApi.orgListTeams(orgName),
  )
  // create all the teams first
  await Promise.all(
    teamIds.map((teamId) => {
      // determine self service flags
      const name = `team-${teamId}`
      if ((teamConfig[teamId]?.selfService?.apps || []).includes('gitea'))
        return upsertTeam(existingTeams, orgApi, { ...adminTeam, name })
      return upsertTeam(existingTeams, orgApi, { ...editorTeam, name })
    }),
  )
  // create org wide viewer team for otomi role "team-viewer"
  await upsertTeam(existingTeams, orgApi, readOnlyTeam)
  // create the org repo
  const repoOption: CreateRepoOption = {
    ...new CreateRepoOption(),
    autoInit: false,
    name: otomiValuesRepoName,
    _private: true,
  }

  const existingRepos = await doApiCall(errors, `Getting all repos in org "${orgName}"`, () =>
    orgApi.orgListRepos(orgName),
  )

  // create main org repo: otomi/values
  await upsertRepo(existingTeams, existingRepos, orgApi, repoApi, repoOption)
  // create otomi/charts repo for auto image updates
  await upsertRepo(existingTeams, existingRepos, orgApi, repoApi, { ...repoOption, name: 'charts' })

  // add repo: otomi/values to the team: otomi-viewer
  await doApiCall(
    errors,
    `Adding repo values to team otomi-viewer`,
    () => repoApi.repoAddTeam(orgName, 'values', 'otomi-viewer'),
    422,
  )

  // add repo: otomi/charts to the team: otomi-viewer
  await doApiCall(
    errors,
    `Adding repo charts to team otomi-viewer`,
    () => repoApi.repoAddTeam(orgName, 'charts', 'otomi-viewer'),
    422,
  )

  // check for specific hooks
  await addTektonHook(repoApi)
  await deleteDroneHook(repoApi)

  if (!hasArgo) return

  // then create initial gitops repo for teams
  await Promise.all(
    teamIds.map(async (teamId) => {
      const name = `team-${teamId}-argocd`
      const option = { ...repoOption, autoInit: true, name }
      // const existingTeamRepos = await doApiCall(
      //   errors,
      //   `Getting all repos from team "${teamId}"`,
      //   () => orgApi.orgListTeamRepos(teamId),
      //   404,
      // )
      return upsertRepo(existingTeams, existingRepos, orgApi, repoApi, option, `team-${teamId}`)
    }),
  )
  if (errors.length) {
    console.error(`Errors found: ${JSON.stringify(errors, null, 2)}`)
    process.exit(1)
  } else {
    console.info('Success!')
  }
}

// EXEC GITEA CLI COMMAND ========================================================================

export function buildTeamString(teamNames: any[]): string {
  if (teamNames === undefined) return '{}'
  const teamObject: groupMapping = {}
  teamNames.forEach((teamName: string) => {
    teamObject[teamName] = { otomi: ['otomi-viewer', teamName] }
  })
  return JSON.stringify(teamObject)
}

async function execGiteaCLICommand(podNamespace: string, podName: string) {
  try {
    console.debug('Finding namespaces')
    let namespaces: any
    try {
      namespaces = (await k8sApi.listNamespace(undefined, undefined, undefined, undefined, 'type=team')).body
    } catch (error) {
      console.debug('No namespaces found, exited with error:', error)
      throw error
    }
    console.debug('Filtering namespaces with "team-" prefix')
    let teamNamespaces: any
    try {
      teamNamespaces = namespaces.items.map((namespace) => namespace.metadata?.name)
    } catch (error) {
      console.debug('Teamnamespaces exited with error:', error)
      throw error
    }
    if (teamNamespaces.length > 0) {
      const teamNamespaceString = buildTeamString(teamNamespaces)
      const execCommand = [
        'sh',
        '-c',
        `AUTH_ID=$(gitea admin auth list --vertical-bars | grep -E "\\|otomi-idp\\s+\\|" | grep -iE "\\|OAuth2\\s+\\|" | awk -F " " '{print $1}' | tr -d '\n') && gitea admin auth update-oauth --id "$AUTH_ID" --group-team-map '${teamNamespaceString}'`,
      ]
      if (podNamespace && podName) {
        const exec = new k8s.Exec(kc)
        // Run gitea CLI command to update the gitea oauth group mapping
        await exec
          .exec(
            podNamespace,
            podName,
            'gitea',
            execCommand,
            null,
            process.stderr as stream.Writable,
            process.stdin as stream.Readable,
            false,
            (status: k8s.V1Status) => {
              console.log('Exited with status:')
              console.log(JSON.stringify(status, null, 2))
              console.debug('Changed group mapping to: ', teamNamespaceString)
            },
          )
          .catch((error) => {
            console.debug('Error occurred during exec:', error)
            throw error
          })
      }
    } else {
      console.debug('No team namespaces found')
    }
  } catch (error) {
    console.debug(`Error updating IDP group mapping: ${error.message}`)
    throw error
  }
}

async function runExecCommand() {
  try {
    await execGiteaCLICommand('gitea', 'gitea-0')
  } catch (error) {
    console.debug('Error could not run exec command', error)
    console.debug('Retrying in 30 seconds')
    await new Promise((resolve) => setTimeout(resolve, 30000))
    console.log('Retrying to run exec command')
    await runExecCommand()
  }
}

// OPERATOR ========================================================================================

export default class MyOperator extends Operator {
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  protected async init() {
    // Watch all namespaces
    try {
      await this.watchResource('', 'v1', 'namespaces', async (e) => {
        const { object }: { object: k8s.V1Pod } = e
        const { metadata } = object
        // Check if namespace starts with prefix 'team-'
        if (metadata && !metadata.name?.startsWith('team-')) return
        if (metadata && metadata.name === 'team-admin') return
        await runExecCommand()
      })
    } catch (error) {
      console.debug(error)
    }
    try {
      await setupGitea()
    } catch (error) {
      console.debug('GITEA SETUP ERROR:', error)
    }
  }
}

async function main(): Promise<void> {
  const operator = new MyOperator()
  console.info(`Listening to team namespace changes in all namespaces`)
  console.info('Setting up namespace prefix filter to "team-"')
  await operator.start()
  const exit = (reason: string) => {
    operator.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => exit('SIGTERM')).on('SIGINT', () => exit('SIGINT'))
}

if (typeof require !== 'undefined' && require.main === module) {
  main()
}
