import {test,expect} from '@playwright/test';
import {cases} from '../../src/cases';
test('normal workspace: WebGL, projection, playback, step, seek, selected lead and reset',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');await expect(page.locator('.scene-host canvas')).toBeVisible();await expect(page.getByRole('heading',{name:'从一个电偶开始',exact:false})).toBeVisible();await expect(page.locator('.wave')).toHaveCount(12);await expect(page.locator('.projection')).toHaveCount(3);
 await expect(page.locator('.scene-time')).toContainText('0.446');await page.getByRole('button',{name:'前进一帧',exact:true}).click();await expect(page.locator('.scene-time')).toContainText('0.448');
 await page.getByRole('button',{name:'播放',exact:true}).click();await expect(page.locator('.scene-time')).not.toContainText('0.448');await page.getByRole('button',{name:'暂停',exact:true}).click();
 await page.getByLabel('当前导联',{exact:true}).selectOption('V1');await expect(page.locator('.wave.selected .lead-button')).toHaveText('V1');
 await page.getByLabel('时间轴',{exact:true}).fill('275');await expect(page.locator('.scene-time')).toContainText('0.550');
 await page.getByRole('button',{name:'复位',exact:true}).click();await expect(page.locator('.scene-time')).toContainText('0.446');
 await page.getByRole('button',{name:'暂停并预测',exact:false}).click();await page.getByRole('button',{name:'负向',exact:true}).click();await expect(page.locator('.quiz-result')).toBeVisible();expect(errors).toEqual([]);
 await expect(page.getByLabel('当前导联局部放大图',{exact:true})).toBeVisible();await expect(page.locator('.projection').nth(1).locator('text').filter({hasText:/^V[1-6]$/})).toHaveCount(6);
 await page.getByRole('button',{name:'复极波前',exact:true}).click();await expect(page.locator('.phase-badge')).toContainText('T');await page.getByRole('button',{name:'除极波前',exact:true}).click();await expect(page.locator('.phase-badge')).toContainText('QRS');
 await page.screenshot({path:'evidence/workspace-desktop.png',fullPage:true});
});
test('camera orbit leaves voltages unchanged; heart rotation and electrode shifts change them',async({page})=>{
 await page.goto('/');const readout=await page.locator('.ecg-summary').innerText();const canvas=page.locator('.scene-host canvas');const box=(await canvas.boundingBox())!;
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.6,{steps:10});await page.mouse.up();expect(await page.locator('.ecg-summary').innerText()).toEqual(readout);
 await page.getByRole('button',{name:'实验参数',exact:false}).click();await page.getByLabel('水平旋转',{exact:true}).fill('70');expect(await page.locator('.ecg-summary').innerText()).not.toEqual(readout);
 await page.getByLabel('当前导联',{exact:true}).selectOption('V1');const before=await page.locator('.ecg-summary').innerText();await page.getByLabel('电极上下位移',{exact:true}).fill('-6');expect(await page.locator('.ecg-summary').innerText()).not.toEqual(before);
 await page.getByRole('button',{name:'理想几何投影',exact:true}).click();await page.getByLabel('手动电偶',{exact:true}).check();await page.getByLabel('电偶额面方向',{exact:true}).fill('90');await page.getByLabel('电偶后向仰角',{exact:true}).fill('0');await page.getByLabel('当前导联',{exact:true}).selectOption('I');await expect(page.locator('.ecg-summary')).toContainText('0.000');
});
test('every declared case switches and displays finite signal, all projections and its own mechanism',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 for(const c of cases){await page.getByLabel('搜索病例',{exact:true}).fill(c.name);await page.getByRole('button',{name:c.name,exact:true}).click();await expect(page.locator('.page-heading h1')).toContainText(c.name);await expect(page.locator('.tutor-body')).toContainText(c.mechanism);await expect(page.locator('.wave')).toHaveCount(12);await expect(page.locator('.projection')).toHaveCount(3);expect(await page.locator('.ecg-summary').innerText()).not.toMatch(/NaN|Infinity/);}
 expect(errors).toEqual([]);
});
test('all four local real records preserve data, show reconstructed VCG and work without external network',async({page})=>{
 const outbound:string[]=[];await page.route('**/*',route=>{if(!route.request().url().startsWith('http://127.0.0.1:5186')){outbound.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto('/');await page.getByRole('button',{name:'真实记录',exact:false}).click();
 for(const id of ['1','172','30','257']){await page.getByLabel('选择真实记录',{exact:true}).selectOption(id);await expect(page.locator('.tutor-body')).toContainText('来源记录 #'+id);await expect(page.locator('.scene-host canvas')).toBeVisible();await expect(page.locator('.wave')).toHaveCount(12);await expect(page.locator('.experiment-toolbar')).toContainText('重建向量环');}
 await page.screenshot({path:'evidence/real-record.png',fullPage:true});expect(outbound).toEqual([]);
 await page.reload();await expect(page.locator('.scene-host canvas')).toBeVisible();expect(outbound).toEqual([]);
});
test('course progress persists and mobile layout fits the viewport',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'理解了，进入下一步',exact:false}).click();await page.reload();await expect(page.locator('.sidebar-label').first()).toContainText('1 / 5');
 await page.setViewportSize({width:390,height:844});await page.reload();await expect(page.locator('.scene-host canvas')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);await page.screenshot({path:'evidence/workspace-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'切换侧栏',exact:true}).click();await expect(page.locator('.sidebar')).toBeVisible();await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();await expect(page.locator('.sidebar')).not.toBeVisible();
});
