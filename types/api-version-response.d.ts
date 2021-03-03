type APIVersionResponse = {
    author?: APIPerson;
    bugs?: object;
    config?: object;
    contributors?: object[];
    dependencies?: object; // used
    description?: string;
    devDependencies?: object;
    directories?: object;
    dist?: { shasum: string, tarball: string; }; // used
    engines?: object;
    jsdelivr?: string;
    homepage?: string;
    keywords?: string[];
    gitHead?: string;
    gitHooks?: object;
    license?: string;
    "lint-staged"?: object;
    main?: string;
    module?: string;
    maintainers?: object[];
    name: string;
    readme?: string;
    readmeFilename?: string;
    repository?: object;
    scripts?: object;
    sideEffects?: boolean;
    typings?: string;
    unpkg?: string;
    version: string;
    _hasShrinkwrap?: false;
    _id?: string;
    _nodeVersion?: string;
    _npmOperationalInternal?: object;
    _npmUser?: string;
    _npmVersion?: string;
};