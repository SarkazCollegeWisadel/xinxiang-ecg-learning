import {test,expect} from '@playwright/test';
test('installed offline cache serves a fresh launch and all four previously unvisited real records',async({page,context})=>{
 await page.goto('/');await expect(page.locator('.sidebar-footer [role=status]')).toHaveText('离线资料已就绪 · 可断网学习',{timeout:30000});
 await expect.poll(()=>page.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
 await context.setOffline(true);
 await page.reload();await expect(page.locator('.scene-host canvas')).toHaveAttribute('data-model-parts','50');await expect(page.locator('.wave')).toHaveCount(12);
 await expect(page.locator('.sidebar-footer [role=status]')).toHaveText('离线资料已就绪 · 可断网学习');
 await page.getByRole('button',{name:'真实记录',exact:false}).click();
 for(const id of ['1','172','30','257']){await page.getByLabel('选择真实记录',{exact:true}).selectOption(id);await expect(page.locator('.tutor-body')).toContainText('来源记录 #'+id);await expect(page.locator('.wave')).toHaveCount(12);}
 const url=page.url();await page.close();const reopened=await context.newPage();await reopened.goto(url);await expect(reopened.locator('.scene-host canvas')).toHaveAttribute('data-model-parts','50');
 await reopened.setViewportSize({width:820,height:1180});await reopened.screenshot({path:'evidence/ipad-offline.png',fullPage:true});await context.setOffline(false);
});
