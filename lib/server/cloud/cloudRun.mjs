import { getVercelOidcToken } from '@vercel/oidc';
import { isUuid } from '../../personal/cloud/timeline.mjs';
export function cloudRunClient(config, { fetchImpl = fetch, oidcToken = getVercelOidcToken } = {}) {
  async function request(url,body,token,method='POST',form=false) {
    const response=await fetchImpl(url,{method,headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},...(body ? {body:form?new URLSearchParams(body).toString():JSON.stringify(body)} : {}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(6000)});
    if(!response.ok) throw new Error('CLOUD_RUN_REQUEST_FAILED');
    return response.json();
  }
  async function accessToken() {
    const subjectToken=await oidcToken();
    if(typeof subjectToken!=='string' || !subjectToken) throw new Error('OIDC_UNAVAILABLE');
    const exchange=await request('https://sts.googleapis.com/v1/token',{
      audience:config.audience,grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',requested_token_type:'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type:'urn:ietf:params:oauth:token-type:jwt',subject_token:subjectToken,scope:'https://www.googleapis.com/auth/cloud-platform',
    },null,'POST',true);
    if(typeof exchange.access_token!=='string' || !exchange.access_token) throw new Error('WIF_FAILED');
    const result=await request(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`,{scope:['https://www.googleapis.com/auth/cloud-platform'],lifetime:'600s'},exchange.access_token);
    if(typeof result.accessToken!=='string' || !result.accessToken) throw new Error('IMPERSONATION_FAILED');
    return result.accessToken;
  }
  async function start(jobId,dispatchId) {
    if(!isUuid(jobId)||!isUuid(dispatchId)) throw new Error('INVALID_DISPATCH');
    const token=await accessToken();
    const definition=await request(`https://run.googleapis.com/v2/${config.resource}`,null,token,'GET');
    verifyJobDefinition(definition);
    // No caller-supplied arguments, URL, image, resources or arbitrary env overrides.
    // Exactly one API attempt. A timeout is ambiguous and must never be retried.
    await request(`https://run.googleapis.com/v2/${config.resource}:run`,{overrides:{taskCount:1,timeout:'660s',containerOverrides:[{name:'worker',env:[{name:'STUDIO_RENDER_JOB_ID',value:jobId},{name:'STUDIO_RENDER_DISPATCH_ID',value:dispatchId}]}]}},token);
  }
  async function cancel(execution) {
    if(typeof execution!=='string'||!new RegExp(`^${config.job}-[a-z0-9-]{1,80}$`).test(execution)) throw new Error('INVALID_EXECUTION');
    const token=await accessToken();
    await request(`https://run.googleapis.com/v2/${config.resource}/executions/${execution}:cancel`,{},token);
  }
  return {start,cancel};
}

export function verifyJobDefinition(definition) {
  const execution=definition?.template,task=execution?.template,container=task?.containers?.[0],limits=container?.resources?.limits;
  if(execution?.taskCount!==1||execution.parallelism!==1||task?.maxRetries!==0||task.timeout!=='660s'||task.containers.length!==1
    ||container.name!=='worker'||limits?.cpu!=='1'||limits?.memory!=='2Gi'||Object.keys(limits).length!==2
    ||!/@sha256:[a-f0-9]{64}$/.test(container.image||'')||task.vpcAccess?.connector
    ||container.command?.length||container.args?.length
    ||!container.volumeMounts?.some(mount=>mount.name==='scratch'&&mount.mountPath==='/tmp')
    ||!container.env?.some(item=>item.name==='STUDIO_WORKER_EXECUTION_ENABLED'&&item.value==='true')
    ||!task.volumes?.some(volume=>volume.name==='scratch'&&volume.emptyDir?.medium==='MEMORY'&&volume.emptyDir.sizeLimit==='256Mi')) throw new Error('CLOUD_JOB_LIMITS_NOT_VERIFIED');
}
