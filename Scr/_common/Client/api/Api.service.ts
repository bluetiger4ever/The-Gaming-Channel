import Axios from 'axios';

export function initClientApiInterceptors() {
	Axios.interceptors.request.use(config => {
		config.headers = { ...config.headers, 'x-gc-client-version': GC_VERSION };
		return config;
	});
}
