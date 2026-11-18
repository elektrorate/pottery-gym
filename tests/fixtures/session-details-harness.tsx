import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import SessionDetailsDialog from '../../components/SessionDetailsDialog';

const mode=new URLSearchParams(location.search).get('mode')==='schedule'?'schedule':'teacher';
const session={id:'session-test',date:'2026-11-18',startTime:'19:00',endTime:'21:00',classType:'mesa',revision:7,capacity:8,students:[],studentIds:[]} as any;
function Harness(){const[open,setOpen]=useState(true); const[calls,setCalls]=useState<any[]>([]);return <><output data-testid="calls">{JSON.stringify(calls)}</output>{open?<SessionDetailsDialog session={session} mode={mode} teachers={[{id:'teacher-a',name:'Erick',surname:'Diaz'}] as any} schedule={[{dayOfWeek:3,isOpen:true,slotIndex:0,opensAt:'10:00',closesAt:'20:00'}] as any} exceptions={[]} readOnly={false} onSave={async(id,updates)=>{setCalls(old=>[...old,{id,updates}]);return !new URLSearchParams(location.search).has('fail');}} onClose={()=>setOpen(false)}/>:<p>Guardado confirmado</p>}</>};createRoot(document.getElementById('root')!).render(<Harness/>);