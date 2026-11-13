import fs from 'node:fs/promises';
const root=new URL('../',import.meta.url),spec=JSON.parse(await fs.readFile(new URL('modeling/heart-spec.json',root),'utf8'));
// Runtime needs geometry and palette, not authoring reports or local evidence paths.
const runtime={medicalReconstruction:{sharedVentricularLoft:spec.medicalReconstruction.sharedVentricularLoft},materials:spec.materials.map(({id,color})=>({id,color})),componentTree:spec.componentTree.map(c=>({id:c.id,parent:c.parent||null,material:c.material,geometryDescriptor:{medicalPath:c.geometryDescriptor?.medicalPath||null},actionProfile:{animationRole:'static',transformChannels:c.actionProfile.transformChannels}}))};
await fs.writeFile(new URL('src/models/heart-runtime.json',root),JSON.stringify(runtime));
