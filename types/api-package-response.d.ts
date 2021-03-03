type APIPackageResponse = {
    author?: string;
    bugs?: object;
    contributors?: object[];
    description?: string;
    directories?: object;
    "dist-tags"?: { latest? : string }; // used
    homepage?: string;
    keywords?: string[];
    license?: string;
    maintainers?: object[];
    name: string;
    readme?: string;
    readmeFilename?: string;
    repository?: object;
    time?: object;
    users?: object;
    versions?: { [version: string]: APIVersionResponse }; // used
    _hasShrinkwrap?: false;
    _id?: string;
    _rev?: string;
};