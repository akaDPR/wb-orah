import { NextFunction, Request, Response } from "express"
import { getRepository } from "typeorm"
import { GroupStudent } from "../entity/group-student.entity"
import { Group } from "../entity/group.entity"
import { Roll } from "../entity/roll.entity"
import { StudentRollState } from "../entity/student-roll-state.entity"
import { Student } from "../entity/student.entity"
import { CreateGroupInput, UpdateGroupInput } from "../interface/group.interface"
import moment = require("moment")
export class GroupController {
  private groupRepository = getRepository(Group)

  private groupStudentRepository = getRepository(GroupStudent)

  private rollRepository = getRepository(Roll)

  private studentRollStateRepository = getRepository(StudentRollState)

  private async deleteAllStudents({ group_id }) {
    return await this.groupStudentRepository.delete({ group_id })
  }

  private async weeksFilter({ number_of_weeks }) {
    const beforeCount = number_of_weeks * 7

    const __fromTime = new Date(Date.now() - beforeCount * 24 * 60 * 60 * 1000).toISOString()

    const __toTime = new Date()

    const agoDate = moment(__fromTime).format("YYYY-MM-DD HH:MM:SS.SSS")
    const currentDate = moment(__toTime).format("YYYY-MM-DD HH:MM:SS.SSS")

    return await this.rollRepository
      .createQueryBuilder("roll")
      .select("roll.id")
      .where("roll.completed_at > :agoDate", { agoDate })
      .andWhere("roll.completed_at < :currentDate", { currentDate })
      .getMany()
      .then((_) => _.map((el) => el.id))
  }

  private async runEach({ grp }) {
    /* STEP 1 : delete all students created previously */

    await this.deleteAllStudents({
      group_id: grp.id,
    })

    /* this is to collect rolls completed within n weeks */
    const filteredRoll = await this.weeksFilter({ number_of_weeks: grp.number_of_weeks })

    const _roll_states = grp.roll_states.split("|").map((_) => _.trim())

    if (filteredRoll.length) {
      return { message: "no rolls found" }
    }

    /*
      SELECT 
      "student_roll_state"."student_id" as student_id, 
      "student_roll_state"."state" as state, 
        COUNT("student_roll_state"."state") AS incident_count 
      FROM 
        "student_roll_state" "student_roll_state" 
      WHERE 
        "student_roll_state"."roll_id" IN (rolls) 
        AND "student_roll_state"."state" IN (states) 
      GROUP BY 
        "student_roll_state"."student_id" 
      HAVING 
        COUNT("student_roll_state"."state") > incidents
    */

    let filteredStudents = await this.studentRollStateRepository
      .createQueryBuilder("student_roll_state")
      .select(["student_roll_state.student_id as student_id", "student_roll_state.state as state"])
      .addSelect("COUNT(student_roll_state.state) AS incident_count")
      .where("student_roll_state.roll_id IN (:...filteredRoll)", { filteredRoll })
      .andWhere("student_roll_state.state IN (:..._roll_states)", { _roll_states })
      .having(`COUNT(student_roll_state.state) ${grp.ltmt} :incidents`, { incidents: grp.incidents })
      .groupBy("student_roll_state.student_id")
      .getRawMany()
      .then((results) => results.map((_) => ({ group_id: grp.id, student_id: _.student_id, incident_count: _.incident_count })))

    /* Bulk insert the populated students  */
    await this.groupRepository.save({
      id: grp.id,
      run_at: new Date().toISOString(),
      student_count: filteredStudents.length,
    })

    /* Update groups with run_at and stduents_count */
    return await this.groupRepository.createQueryBuilder("group_student").insert().into(GroupStudent).values(filteredStudents).execute()
  }

  async allGroups(request: Request, response: Response, next: NextFunction) {
    // Task 1:
    // Return the list of all groups
    return this.groupRepository.find()
  }

  async createGroup(request: Request, response: Response, next: NextFunction) {
    // Task 1:
    // Add a Group
    const { body: params } = request
    const CreateGroupInput: CreateGroupInput = {
      name: params.name,
      number_of_weeks: params.number_of_weeks,
      roll_states: params.roll_states,
      incidents: params.incidents,
      ltmt: params.ltmt,
      student_count: params.student_count,
      run_at: params.run_at,
    }
    const group = new Group()
    group.prepareToCreate(CreateGroupInput)

    return this.groupRepository.save(group)
  }

  async updateGroup(request: Request, response: Response, next: NextFunction) {
    // Task 1:
    // Update a Group

    const { body: params } = request

    this.groupRepository.findOne(params.id).then((group) => {
      const updateGroupInput: UpdateGroupInput = {
        id: params.id,
        name: params.name,
        number_of_weeks: params.number_of_weeks,
        roll_states: params.roll_states,
        incidents: params.incidents,
        ltmt: params.ltmt,
        student_count: params.student_count,
        run_at: params.run_at,
      }

      group.prepareToUpdate(updateGroupInput)

      return this.groupRepository.save(group)
    })
  }

  async removeGroup(request: Request, response: Response, next: NextFunction) {
    // Task 1:
    // Delete a Group
    let groupToRemove = await this.groupRepository.findOne(request.params.id)
    await this.groupRepository.remove(groupToRemove)
  }

  async getGroupStudents(request: Request, response: Response, next: NextFunction) {
    // Task 1:
    // Return the list of Students that are in a Group

    const allStudents = await this.groupStudentRepository
      .createQueryBuilder("group_student")
      .select(["group.id as group_id", "group.name as group_name"])
      .addSelect(["student.first_name AS first_name", "student.last_name AS last_name", "student.first_name || ' ' ||student.last_name  AS full_name"])
      .innerJoin(Group, "group", "group_student.group_id =  group.id")
      .innerJoin(Student, "student", "group_student.student_id = student.id")
      .getRawMany()
      .then((results) =>
        results.reduce((acc, value) => {
          if (!acc[value.group_name]) {
            acc[value.group_name] = []
          }

          acc[value.group_name].push({ first_name: value.first_name, last_name: value.last_name, full_name: value.full_name })

          return acc
        }, {})
      )

    /*
      SELECT '{ "group": ' || group_name || ',' || '"student": [ ' || group_concat(json) || '] }' 

      FROM( SELECT 'group'.name AS group_name, '{"name": "' || student.first_name || '" }' AS json 
                  FROM       student 
                  INNER JOIN group_student 
                  ON         student.id = group_student.student_id 
                  INNER JOIN 'group' 
                  ON         'group'.id = group_student.group_id 
                  GROUP BY   'group');
    */

    return allStudents
  }

  async runGroupFilters(request: Request, response: Response, next: NextFunction) {
    // Task 2:

    // 1. Clear out the groups (delete all the students from the groups)
    // 2. For each group, query the student rolls to see which students match the filter for the group
    // 3. Add the list of students that match the filter to the group

    /* to collect all groups */
    const allGroups = await this.groupRepository
      .createQueryBuilder("group")
      .select(["group.id", "group.number_of_weeks", "group.roll_states", "group.incidents", "group.ltmt"])
      .getMany()

    /* Using promise.all will cause fast-fail scenario, you can handle it by mapping it into and pick catch */
    const _promises = []

    /*
      runEach will hold a responsibilty of performing filters for a group
    */

    allGroups.forEach((grp) => {
      _promises.push(this.runEach({ grp }))
    })

    return await Promise.allSettled(_promises).then((results) => results)
  }
}

/*
  UPDATE `sqlite_sequence` SET `seq` = 0 WHERE `name` = 'roll';

  TODO: script to populate random value 
  May 1 : [ 10 Present + 5 absent  +  5 late  ]
  May 2 : [ 15 Present + 5 absent  +  0 late  ]
  May 3 : [ 6 Present  + 4 absent  +  10 late  ]
  May 4 : [ 5 Present  + 10 absent +  5 late  ]
  May 5 : [ 1 Present  + 19 absent +  0 late  ]
*/
