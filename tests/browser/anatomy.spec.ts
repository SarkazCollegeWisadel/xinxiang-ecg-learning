import {test,expect} from '@playwright/test';
test('anatomical model, views, part selection, explode and lead picking preserve the electrical timeline',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 const canvas=page.locator('.scene-host canvas');await expect(canvas).toHaveAttribute('data-model-source','img2threejs-atlas');await expect(canvas).toHaveAttribute('data-model-parts','50');
 const signal=await page.locator('.ecg-summary').innerText(),time=await page.locator('.scene-time').innerText();
 await page.getByLabel('三维标注 右心房',{exact:true}).click();await expect(page.locator('.anatomy-detail strong')).toHaveText('右心房');
 await page.getByLabel('部件拆解',{exact:true}).fill('.65');await page.getByRole('button',{name:'背面',exact:true}).click();
 expect(await page.locator('.ecg-summary').innerText()).toEqual(signal);await expect(page.locator('.scene-time')).toHaveText(time);
 await page.screenshot({path:'evidence/anatomy-exploded.png',fullPage:true});
 await page.getByLabel('部件拆解',{exact:true}).fill('0');await page.getByRole('button',{name:'正面',exact:true}).click();await page.getByRole('button',{name:'心脏近景',exact:true}).click();
 await page.getByLabel('三维标注 左心室',{exact:true}).click();await page.screenshot({path:'evidence/anatomy-desktop.png',fullPage:true});await page.locator('.anatomy-view').screenshot({path:'evidence/anatomy-closeup.png'});
 await page.getByRole('button',{name:'胸廓定位',exact:true}).click();await page.getByLabel('三维标注 V4',{exact:true}).click();await expect(page.getByLabel('当前导联',{exact:true})).toHaveValue('V4');
 await expect(page.locator('.scene-time')).toHaveText(time);await page.locator('.anatomy-view').screenshot({path:'evidence/anatomy-thorax.png'});
 await page.getByRole('button',{name:'传导路径',exact:true}).click();await expect(page.locator('.anatomy-detail strong')).toContainText('传导网络');await page.locator('.anatomy-view').screenshot({path:'evidence/anatomy-conduction.png'});
 await page.getByRole('button',{name:'心脏近景',exact:true}).click();await expect(canvas).toHaveAttribute('data-model-parts','50');expect(errors).toEqual([]);
});


