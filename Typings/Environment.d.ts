declare const GC_SECTION: string;
declare const GC_ENVIRONMENT: 'development' | 'production';
declare const GC_BUILD_TYPE: 'development' | 'production';
declare const GC_IS_CLIENT: boolean;
declare const GC_IS_SSR: boolean;
declare const GC_VERSION: string;
declare const GC_MANIFEST_URL: string;
declare const GC_WITH_UPDATER: boolean;
declare const GC_IS_WATCHING: boolean;
declare const GC_TUNNELS: {
	backend?: string;
	frontend?: string;
};
